package documents

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/breeding"
	"dogclub.local/backend/internal/dogs"
	"dogclub.local/backend/internal/events"
	"dogclub.local/backend/internal/members"
	"dogclub.local/backend/internal/platform/filestore"
	"dogclub.local/backend/internal/platform/notify"
	"dogclub.local/backend/internal/veterinary"

	"github.com/jackc/pgx/v5"
)

type Service struct {
	notifications notify.Sink
	access        *auth.Service
	members       *members.Service
	dogs          *dogs.Service
	vet           *veterinary.Service
	files         *filestore.Store
	now           func() time.Time
	breeding      *breeding.Service
	events        *events.Service
}

func NewService(a *auth.Service, m *members.Service, d *dogs.Service, v *veterinary.Service, f *filestore.Store, b *breeding.Service, e *events.Service) *Service {
	return &Service{access: a, members: m, dogs: d, vet: v, files: f, now: time.Now, breeding: b, events: e}
}

var readRoles = []string{"staff", "veterinarian", "leader", "owner", "expert"}

func domainError(err error) error {
	for _, e := range []error{members.ErrNotFound, dogs.ErrNotFound, veterinary.ErrNotFound, breeding.ErrNotFound, events.ErrNotFound} {
		if errors.Is(err, e) {
			return ErrNotFound
		}
	}
	for _, e := range []error{members.ErrUnavailable, dogs.ErrUnavailable, veterinary.ErrUnavailable, filestore.ErrUnavailable, breeding.ErrUnavailable, events.ErrUnavailable} {
		if errors.Is(err, e) {
			return ErrUnavailable
		}
	}
	var m *members.ValidationError
	var d *dogs.ValidationError
	var v *veterinary.ValidationError
	var b *breeding.ValidationError
	var e *events.ValidationError
	if errors.As(err, &e) && len(e.Fields) > 0 {
		return invalid(e.Fields[0].Field, e.Fields[0].Message)
	}
	if errors.As(err, &m) || errors.As(err, &d) || errors.As(err, &v) || errors.As(err, &b) {
		return invalid("source", "Проверьте исходные данные документа.")
	}
	return err
}
func (s *Service) with(ctx context.Context, p auth.Principal, roles []string, fn func(context.Context, *repository, auth.Principal) error) error {
	return domainError(s.access.WithAccess(ctx, p, roles, func(ctx context.Context, tx pgx.Tx, p auth.Principal) error {
		ctx = notify.WithSink(ctx, s.notifications)
		if p.Profile.Role == "owner" {
			if _, err := s.members.RequireActiveOwner(ctx, tx, p); err != nil {
				return err
			}
		}
		return fn(ctx, &repository{tx}, p)
	}))
}
func (s *Service) read(ctx context.Context, q *repository, p auth.Principal, id int32) (Document, error) {
	d, err := q.get(ctx, id)
	if err != nil {
		return d, err
	}
	if p.Profile.Role == "owner" {
		if d.Status == "legacy" {
			return Document{}, ErrNotFound
		}
		own, err := s.members.RequireActiveOwner(ctx, q.tx, p)
		if err != nil {
			return d, err
		}
		if d.MemberID != nil {
			if *d.MemberID != own {
				return Document{}, ErrNotFound
			}
		} else {
			if d.RecipientMemberID == nil || *d.RecipientMemberID != own || d.DogID == nil {
				return Document{}, ErrNotFound
			}
			if _, err := s.dogs.ReadForDocuments(ctx, q.tx, p, *d.DogID); err != nil {
				return d, err
			}
		}
		d.LegacyMemberID = nil
	}
	if p.Profile.Role == "veterinarian" && ((d.Status == "legacy" && category(d.TypeName) != "medical") || (d.Status != "legacy" && (d.Category == nil || *d.Category != "medical"))) {
		return Document{}, ErrNotFound
	}
	if p.Profile.Role == "expert" && category(d.TypeName) != "breeding" {
		if d.EventID == nil || s.events == nil {
			return Document{}, ErrNotFound
		}
		if err := s.events.DocumentAccess(ctx, q.tx, p, *d.EventID); err != nil {
			return Document{}, hiddenEventError(err)
		}
	}
	d.Expired = d.ExpiresOn != nil && *d.ExpiresOn < s.now().UTC().Format(time.DateOnly)
	for i, f := range d.Files {
		if f.Template != nil {
			var in Generate
			if json.Unmarshal(f.SourceInput, &in) != nil {
				return d, ErrUnavailable
			}
			snapshot, err := s.source(ctx, q, p, d, in, false)
			changed := err != nil
			if err != nil && !errors.Is(err, ErrNotFound) {
				var ve *ValidationError
				if !errors.As(err, &ve) {
					return d, err
				}
			}
			if err == nil {
				b, err := json.Marshal(snapshot)
				if err != nil {
					return d, ErrUnavailable
				}
				changed = !equalJSON(b, f.Snapshot)
			}
			d.Files[i].SourceChanged = &changed
		}
	}
	return d, nil
}
func equalJSON(a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	aa, _ := json.Marshal(x)
	bb, _ := json.Marshal(y)
	return bytes.Equal(aa, bb)
}
func (s *Service) Get(ctx context.Context, p auth.Principal, id int32) (Document, error) {
	var d Document
	err := s.with(ctx, p, readRoles, func(ctx context.Context, q *repository, p auth.Principal) error {
		var e error
		d, e = s.read(ctx, q, p, id)
		return e
	})
	d.Expired = d.ExpiresOn != nil && *d.ExpiresOn < s.now().UTC().Format(time.DateOnly)
	return d, err
}
func (s *Service) Types(ctx context.Context, p auth.Principal) ([]DocumentType, error) {
	var out []DocumentType
	err := s.with(ctx, p, readRoles, func(ctx context.Context, q *repository, p auth.Principal) error {
		var e error
		out, e = q.types(ctx)
		if p.Profile.Role == "expert" {
			filtered := []DocumentType{}
			for _, item := range out {
				if item.Category == "breeding" || item.Name == "Диплом" || eventType(item.Name) {
					filtered = append(filtered, item)
				}
			}
			out = filtered
		}
		return e
	})
	return out, err
}
func (s *Service) List(ctx context.Context, p auth.Principal, f Filter) (Page[Document], error) {
	out := Page[Document]{Records: []Document{}}
	if err := validFilter(f); err != nil {
		return out, err
	}
	if f.After > 1<<31-1 {
		return out, invalid("after", "Не удалось загрузить список. Обновите страницу.")
	}
	err := s.with(ctx, p, readRoles, func(ctx context.Context, q *repository, p auth.Principal) error {
		var own *int32
		dogIDs := []int32{}
		if p.Profile.Role == "owner" {
			id, err := s.members.RequireActiveOwner(ctx, q.tx, p)
			if err != nil {
				return err
			}
			own = &id
			dogIDs, err = s.dogs.EventOwnerDogIDs(ctx, q.tx, p)
			if err != nil {
				return err
			}
		}
		assigned := []int32{}
		if p.Profile.Role == "expert" && s.events != nil {
			var err error
			assigned, err = s.events.DocumentEventIDs(ctx, q.tx, p)
			if err != nil {
				return err
			}
		}
		ids, err := q.list(ctx, f, own, dogIDs, p.Profile.Role == "veterinarian", p.Profile.Role == "expert", assigned)
		if err != nil {
			return err
		}
		if len(ids) > f.Limit {
			ids = ids[:f.Limit]
			id := int64(ids[len(ids)-1])
			out.NextAfter = &id
		}
		for _, id := range ids {
			d, err := s.read(ctx, q, p, id)
			if err != nil {
				return err
			}
			out.Records = append(out.Records, d)
		}
		return nil
	})
	return out, err
}
func (s *Service) references(ctx context.Context, q *repository, p auth.Principal, in Input) (string, error) {
	types, err := q.types(ctx)
	if err != nil {
		return "", err
	}
	var cat string
	for _, t := range types {
		if t.ID == in.TypeID {
			cat = t.Category
		}
	}
	if cat == "" {
		return "", invalid("type_id", "Тип документа не найден.")
	}
	if cat == "medical" {
		if err := auth.RequireProfile(p, "veterinarian"); err != nil {
			return "", err
		}
		if p.User.ClubMemberID == nil {
			return "", auth.ErrForbidden
		}
		if in.DogID == nil {
			return "", invalid("dog_id", "Медицинский документ относится к собаке.")
		}
	} else if err := auth.RequireProfile(p, "staff"); err != nil {
		return "", err
	}
	if in.MemberID != nil {
		if _, err := s.members.ReadForDocuments(ctx, q.tx, p, *in.MemberID); err != nil {
			return "", err
		}
	}
	if in.DogID != nil {
		d, err := s.dogs.ReadForDocuments(ctx, q.tx, p, *in.DogID)
		if err != nil {
			return "", err
		}
		if in.RecipientMemberID != nil {
			found := false
			for _, id := range d.OwnerIDs {
				if id == *in.RecipientMemberID {
					found = true
				}
			}
			if !found {
				return "", invalid("recipient_member_id", "Получатель должен быть текущим владельцем собаки.")
			}
			if _, err := s.members.DocumentIdentity(ctx, q.tx, p, *in.RecipientMemberID); err != nil {
				return "", err
			}
		}
	}
	if cat == "breeding" {
		if in.DogID == nil || s.breeding == nil {
			return "", invalid("breeding_decision_id", "Укажите собаку и племенное основание.")
		}
		name := ""
		for _, t := range types {
			if t.ID == in.TypeID {
				name = t.Name
			}
		}
		if name == "Заключение о вязке" && (in.BreedingDecisionID == nil || in.LitterID != nil) || name == "Акт о регистрации помёта" && (in.LitterID == nil || in.BreedingDecisionID != nil) {
			return "", invalid("breeding_decision_id", "Основание не соответствует типу документа.")
		}
		if _, err := s.breeding.ReadForDocuments(ctx, q.tx, p, *in.DogID, in.BreedingDecisionID, in.LitterID, in.RecipientMemberID != nil, false); err != nil {
			return "", domainError(err)
		}
	} else if in.BreedingDecisionID != nil || in.LitterID != nil {
		return "", invalid("breeding_decision_id", "Этот тип документа не использует племенные основания.")
	}
	if err := s.eventReferences(ctx, q, p, in, cat, types); err != nil {
		return "", err
	}
	return cat, nil
}
func (s *Service) Create(ctx context.Context, p auth.Principal, in Input) (Document, error) {
	var d Document
	if err := validate(&in, s.now().UTC().Format(time.DateOnly)); err != nil {
		return d, err
	}
	err := s.with(ctx, p, []string{"staff", "veterinarian"}, func(ctx context.Context, q *repository, p auth.Principal) error {
		cat, err := s.references(ctx, q, p, in)
		if err != nil {
			return err
		}
		id, err := q.save(ctx, 0, in, cat)
		if err != nil {
			return err
		}
		d, err = q.get(ctx, id)
		if err != nil {
			return err
		}
		return q.record(ctx, p, d, "created", "", nil)
	})
	d.Expired = d.ExpiresOn != nil && *d.ExpiresOn < s.now().UTC().Format(time.DateOnly)
	return d, err
}
func writeAllowed(p auth.Principal, d Document) error {
	cat := category(d.TypeName)
	if d.Category != nil {
		cat = *d.Category
	}
	if cat == "medical" {
		return auth.RequireProfile(p, "veterinarian")
	}
	return auth.RequireProfile(p, "staff")
}
func same(a, b *int32) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
func (s *Service) Update(ctx context.Context, p auth.Principal, id int32, in Update) (Document, error) {
	var d Document
	if err := validate(&in.Input, s.now().UTC().Format(time.DateOnly)); err != nil {
		return d, err
	}
	if err := correction(&in.Correction); err != nil {
		return d, err
	}
	err := s.with(ctx, p, []string{"staff", "veterinarian"}, func(ctx context.Context, q *repository, p auth.Principal) error {
		before, err := q.get(ctx, id)
		if err != nil {
			return err
		}
		if err = writeAllowed(p, before); err != nil {
			return err
		}
		if before.Version != in.Version || before.Status == "void" {
			return ErrConflict
		}
		if len(before.Files) > 0 && (!same(before.DogID, in.DogID) || !same(before.MemberID, in.MemberID) || !same(before.RecipientMemberID, in.RecipientMemberID) || before.TypeID != in.TypeID || !same64(before.BreedingDecisionID, in.BreedingDecisionID) || !same64(before.LitterID, in.LitterID) || !same(before.EventID, in.EventID) || !same(before.EventResultID, in.EventResultID)) {
			return invalid("subject", "Документ с файлами нельзя переносить другому получателю, объекту или типу.")
		}
		cat, err := s.references(ctx, q, p, in.Input)
		if err != nil {
			return err
		}
		if err = q.bump(ctx, id, in.Version); err != nil {
			return err
		}
		if _, err = q.save(ctx, id, in.Input, cat); err != nil {
			return err
		}
		d, err = q.get(ctx, id)
		if err != nil {
			return err
		}
		return q.record(ctx, p, d, "corrected", in.Reason, &before)
	})
	d.Expired = d.ExpiresOn != nil && *d.ExpiresOn < s.now().UTC().Format(time.DateOnly)
	return d, err
}
func (s *Service) Void(ctx context.Context, p auth.Principal, id int32, in Correction) (Document, error) {
	var d Document
	if err := correction(&in); err != nil {
		return d, err
	}
	err := s.with(ctx, p, []string{"staff", "veterinarian"}, func(ctx context.Context, q *repository, p auth.Principal) error {
		before, err := q.get(ctx, id)
		if err != nil {
			return err
		}
		if before.Status == "legacy" {
			return invalid("document", "Сначала уточните старую запись.")
		}
		if err = writeAllowed(p, before); err != nil {
			return err
		}
		if before.Status == "void" {
			return ErrConflict
		}
		if err = q.bump(ctx, id, in.Version); err != nil {
			return err
		}
		if err = q.void(ctx, id); err != nil {
			return err
		}
		d, err = q.get(ctx, id)
		if err != nil {
			return err
		}
		return q.record(ctx, p, d, "voided", in.Reason, &before)
	})
	d.Expired = d.ExpiresOn != nil && *d.ExpiresOn < s.now().UTC().Format(time.DateOnly)
	return d, err
}
func (s *Service) History(ctx context.Context, p auth.Principal, id int32, f Filter) (Page[Change], error) {
	var out Page[Change]
	if err := validFilter(f); err != nil {
		return out, err
	}
	err := s.with(ctx, p, readRoles, func(ctx context.Context, q *repository, p auth.Principal) error {
		if _, err := s.read(ctx, q, p, id); err != nil {
			return err
		}
		var err error
		out, err = q.history(ctx, id, f)
		if p.Profile.Role == "owner" {
			for i := range out.Records {
				out.Records[i].Before = nil
				out.Records[i].After = nil
			}
		}
		return err
	})
	return out, err
}

func same64(a, b *int64) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }

func (s *Service) SetNotificationSink(sink notify.Sink) { s.notifications = sink }
