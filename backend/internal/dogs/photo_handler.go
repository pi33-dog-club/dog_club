package dogs

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/platform/httpapi"
)

func (h *Handler) photo(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	out, err := h.service.Photo(r.Context(), auth.PrincipalFrom(r), id)
	respond(w, r, out, err)
}

// photoFile serves the image inline for <img>; nosniff and a sandbox CSP keep
// the bytes from being treated as anything but a picture.
func (h *Handler) photoFile(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	meta, data, err := h.service.PhotoFile(r.Context(), auth.PrincipalFrom(r), id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	ext := "jpg"
	if meta.MediaType == "image/png" {
		ext = "png"
	}
	w.Header().Set("Content-Type", meta.MediaType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="dog-%d.%s"`, id, ext))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.WriteHeader(200)
	_, _ = w.Write(data)
}

// setPhoto takes multipart/form-data with exactly one file and one version.
func (h *Handler) setPhoto(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxPhotoSize+(64<<10))
	reader, err := r.MultipartReader()
	if err != nil {
		httpapi.WriteProblem(w, r, httpapi.NewProblem(415, "unsupported_media_type", "Не удалось прочитать файл. Выберите его ещё раз и повторите."))
		return
	}
	var data []byte
	var media string
	var version int64
	seen := map[string]bool{}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			photoUploadError(w, r, err)
			return
		}
		key := part.FormName()
		if key != "file" && key != "version" || seen[key] {
			part.Close()
			writeError(w, r, invalid("multipart", "Не удалось прочитать файл. Выберите его ещё раз и повторите."))
			return
		}
		seen[key] = true
		limit := int64(32)
		if key == "file" {
			limit = MaxPhotoSize
		}
		b, err := io.ReadAll(io.LimitReader(part, limit+1))
		part.Close()
		if err != nil {
			photoUploadError(w, r, err)
			return
		}
		if int64(len(b)) > limit {
			httpapi.WriteProblem(w, r, httpapi.NewProblem(413, "body_too_large", "Фото должно быть не больше 5 МБ."))
			return
		}
		if key == "file" {
			data, media = b, part.Header.Get("Content-Type")
			continue
		}
		version, err = strconv.ParseInt(string(b), 10, 64)
		if err != nil {
			writeError(w, r, invalid("version", "Неверная версия."))
			return
		}
	}
	if len(seen) != 2 {
		writeError(w, r, invalid("multipart", "Выберите файл."))
		return
	}
	out, err := h.service.SetPhoto(r.Context(), auth.PrincipalFrom(r), id, version, media, data)
	respond(w, r, out, err)
}

func (h *Handler) removePhoto(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	var in PhotoRemoval
	if !decode(w, r, &in) {
		return
	}
	if err := h.service.RemovePhoto(r.Context(), auth.PrincipalFrom(r), id, in); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(204)
}

func photoUploadError(w http.ResponseWriter, r *http.Request, err error) {
	var size *http.MaxBytesError
	if errors.As(err, &size) {
		httpapi.WriteProblem(w, r, httpapi.NewProblem(413, "body_too_large", "Фото должно быть не больше 5 МБ."))
		return
	}
	httpapi.WriteProblem(w, r, httpapi.NewProblem(400, "invalid_json", "Не удалось прочитать файл. Выберите его ещё раз и повторите."))
}
