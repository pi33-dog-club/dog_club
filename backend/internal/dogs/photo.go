package dogs

import (
	"bytes"
	"context"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"time"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/platform/filestore"
	"github.com/jackc/pgx/v5"
)

// MaxPhotoSize bounds one dog photo; documents keep their own larger limit.
const MaxPhotoSize = 5 << 20

// Photo is the current picture of a dog. It has its own version: replacing it is
// not a change of the dog's facts, so the card version that qualification
// fingerprints and document snapshots rely on stays the same.
type Photo struct {
	DogID     int32     `json:"dog_id"`
	MediaType string    `json:"media_type"`
	SizeBytes int64     `json:"size_bytes"`
	Width     int       `json:"width"`
	Height    int       `json:"height"`
	Version   int64     `json:"version"`
	UpdatedAt time.Time `json:"updated_at"`
	key       string
	sha256    string
}

type PhotoRemoval struct {
	Version int64  `json:"version"`
	Reason  string `json:"reason"`
}

// Everyone who meets the dog in a module sees its photo; an owner only for own dogs.
var photoReaders = []string{"staff", "leader", "owner", "veterinarian", "expert"}

func (s *Service) SetPhotoStore(files *filestore.Store) { s.photos = files }

func (p Photo) blob() filestore.Blob {
	return filestore.Blob{Key: p.key, Size: p.SizeBytes, SHA256: p.sha256}
}

// validatePhoto trusts neither the name nor the declared type: the decoded
// header must agree with the media type, and the picture stays within 40 MP.
func validatePhoto(media string, data []byte) (int, int, error) {
	if len(data) == 0 || len(data) > MaxPhotoSize {
		return 0, 0, invalid("file", "Фото должно быть не больше 5 МБ.")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 40000000 {
		return 0, 0, invalid("file", "Изображение повреждено или слишком большое. Уменьшите его и загрузите снова.")
	}
	if media != "image/jpeg" && media != "image/png" {
		return 0, 0, invalid("file", "Разрешены JPEG и PNG.")
	}
	if media == "image/jpeg" && format != "jpeg" || media == "image/png" && format != "png" {
		return 0, 0, invalid("file", "Тип файла не совпадает с его содержимым.")
	}
	return config.Width, config.Height, nil
}

func (s *Service) Photo(ctx context.Context, p auth.Principal, id int32) (Photo, error) {
	var result Photo
	err := s.access.WithAccess(ctx, p, photoReaders, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		if err := s.readAccess(ctx, tx, current, id); err != nil {
			return err
		}
		q := &repository{tx}
		if _, err := q.summary(ctx, id); err != nil {
			return err
		}
		var err error
		result, err = q.photo(ctx, id)
		return err
	})
	return result, err
}

// PhotoFile reads the bytes outside the transaction and then checks that access
// and the photo itself did not change during the slow disk read.
func (s *Service) PhotoFile(ctx context.Context, p auth.Principal, id int32) (Photo, []byte, error) {
	if s.photos == nil {
		return Photo{}, nil, ErrUnavailable
	}
	meta, err := s.Photo(ctx, p, id)
	if err != nil {
		return Photo{}, nil, err
	}
	data, err := s.photos.Read(ctx, meta.blob())
	if err != nil {
		return Photo{}, nil, ErrUnavailable
	}
	current, err := s.Photo(ctx, p, id)
	if err != nil {
		return Photo{}, nil, err
	}
	if current.Version != meta.Version || current.key != meta.key {
		return Photo{}, nil, ErrConflict
	}
	return meta, data, nil
}

// SetPhoto stores a new photo or replaces the current one; version 0 means none yet.
// The blob is written before the transaction and discarded if it does not commit.
func (s *Service) SetPhoto(ctx context.Context, p auth.Principal, id int32, version int64, media string, data []byte) (Photo, error) {
	if version < 0 {
		return Photo{}, invalid("version", "Укажите текущую версию фото или 0, если фото нет.")
	}
	width, height, err := validatePhoto(media, data)
	if err != nil {
		return Photo{}, err
	}
	if s.photos == nil {
		return Photo{}, ErrUnavailable
	}
	// Refuse early, before writing bytes, when the caller may not or the version is stale.
	if err := s.photoWritable(ctx, p, id, version); err != nil {
		return Photo{}, err
	}
	blob, err := s.photos.Put(ctx, data)
	if err != nil {
		return Photo{}, ErrUnavailable
	}
	var result, previous Photo
	replaced := false
	commitAttempt := false
	err = s.access.WithAccess(ctx, p, []string{"staff"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		q := &repository{tx}
		dog, err := q.card(ctx, id)
		if err != nil {
			return err
		}
		previous, replaced, err = q.currentPhoto(ctx, id, version)
		if err != nil {
			return err
		}
		next := Photo{DogID: id, MediaType: media, SizeBytes: blob.Size, Width: width, Height: height, key: blob.Key, sha256: blob.SHA256}
		if err := q.savePhoto(ctx, current, next, version); err != nil {
			return err
		}
		result, err = q.photo(ctx, id)
		if err != nil {
			return err
		}
		if err := q.record(ctx, current, "photo_set", "", &dog, dog); err != nil {
			return err
		}
		commitAttempt = true
		return nil
	})
	if err != nil {
		if !commitAttempt {
			_ = s.photos.Discard(blob)
		}
		return Photo{}, err
	}
	if replaced {
		// The old bytes are no longer referenced; a failed removal only leaves an orphan file.
		_ = s.photos.Discard(previous.blob())
	}
	return result, nil
}

func (s *Service) RemovePhoto(ctx context.Context, p auth.Principal, id int32, in PhotoRemoval) error {
	if in.Version < 1 {
		return invalid("version", "Укажите текущую версию фото.")
	}
	if err := reasonValid(in.Reason); err != nil {
		return err
	}
	if s.photos == nil {
		return ErrUnavailable
	}
	var previous Photo
	err := s.access.WithAccess(ctx, p, []string{"staff"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		q := &repository{tx}
		dog, err := q.card(ctx, id)
		if err != nil {
			return err
		}
		previous, _, err = q.currentPhoto(ctx, id, in.Version)
		if err != nil {
			return err
		}
		if err := q.deletePhoto(ctx, id, in.Version); err != nil {
			return err
		}
		return q.record(ctx, current, "photo_removed", in.Reason, &dog, dog)
	})
	if err != nil {
		return err
	}
	_ = s.photos.Discard(previous.blob())
	return nil
}

func (s *Service) photoWritable(ctx context.Context, p auth.Principal, id int32, version int64) error {
	return s.access.WithAccess(ctx, p, []string{"staff"}, func(ctx context.Context, tx pgx.Tx, _ auth.Principal) error {
		q := &repository{tx}
		if _, err := q.summary(ctx, id); err != nil {
			return err
		}
		_, _, err := q.currentPhoto(ctx, id, version)
		return err
	})
}

const photoColumns = `dog_id,storage_key,media_type,size_bytes,sha256,width,height,version,updated_at`

func (q *repository) photo(ctx context.Context, id int32) (Photo, error) {
	var out Photo
	err := q.tx.QueryRow(ctx, `SELECT `+photoColumns+` FROM dog_photo WHERE dog_id=$1`, id).
		Scan(&out.DogID, &out.key, &out.MediaType, &out.SizeBytes, &out.sha256, &out.Width, &out.Height, &out.Version, &out.UpdatedAt)
	return out, storageError(err)
}

// currentPhoto checks the expected version: 0 when the dog has no photo yet.
func (q *repository) currentPhoto(ctx context.Context, id int32, version int64) (Photo, bool, error) {
	current, err := q.photo(ctx, id)
	if errors.Is(err, ErrNotFound) {
		if version != 0 {
			return Photo{}, false, ErrConflict
		}
		return Photo{}, false, nil
	}
	if err != nil {
		return Photo{}, false, err
	}
	if current.Version != version {
		return Photo{}, false, ErrConflict
	}
	return current, true, nil
}

func (q *repository) savePhoto(ctx context.Context, p auth.Principal, ph Photo, version int64) error {
	if version == 0 {
		// Versions keep growing across removals: each set or removal is one history entry.
		_, err := q.tx.Exec(ctx, `INSERT INTO dog_photo(dog_id,storage_key,media_type,size_bytes,sha256,width,height,updated_by_profile_id,version)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,(SELECT count(*)+1 FROM dog_changes WHERE dog_id=$1 AND action IN ('photo_set','photo_removed')))`,
			ph.DogID, ph.key, ph.MediaType, ph.SizeBytes, ph.sha256, ph.Width, ph.Height, p.Profile.ID)
		return storageError(err)
	}
	tag, err := q.tx.Exec(ctx, `UPDATE dog_photo SET storage_key=$3,media_type=$4,size_bytes=$5,sha256=$6,width=$7,height=$8,updated_by_profile_id=$9,version=version+1,updated_at=now() WHERE dog_id=$1 AND version=$2`,
		ph.DogID, version, ph.key, ph.MediaType, ph.SizeBytes, ph.sha256, ph.Width, ph.Height, p.Profile.ID)
	if err != nil {
		return storageError(err)
	}
	if tag.RowsAffected() != 1 {
		return ErrConflict
	}
	return nil
}

func (q *repository) deletePhoto(ctx context.Context, id int32, version int64) error {
	tag, err := q.tx.Exec(ctx, `DELETE FROM dog_photo WHERE dog_id=$1 AND version=$2`, id, version)
	if err != nil {
		return storageError(err)
	}
	if tag.RowsAffected() != 1 {
		return ErrConflict
	}
	return nil
}
