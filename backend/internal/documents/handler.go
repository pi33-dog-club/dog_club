package documents

import (
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/platform/filestore"
	"dogclub.local/backend/internal/platform/httpapi"

	"github.com/go-chi/chi/v5"
)

type Handler struct {
	service *Service
	account *auth.Handler
}

func NewHandler(s *Service, a *auth.Handler) *Handler { return &Handler{s, a} }
func (h *Handler) RegisterRoutes(router chi.Router) {
	router.Group(func(r chi.Router) {
		r.Use(httpapi.Protect, h.account.RequireAccount)
		r.Get("/document-types", func(w http.ResponseWriter, r *http.Request) {
			out, err := h.service.Types(r.Context(), auth.PrincipalFrom(r))
			respond(w, r, out, err)
		})
		r.Get("/documents", func(w http.ResponseWriter, r *http.Request) {
			f, ok := filter(w, r)
			if !ok {
				return
			}
			out, err := h.service.List(r.Context(), auth.PrincipalFrom(r), f)
			respond(w, r, out, err)
		})
		r.Post("/documents", command(h, true, func(ctx context.Context, p auth.Principal, _ int32, in Input) (Document, error) {
			return h.service.Create(ctx, p, in)
		}))
		r.Get("/documents/{documentID}", func(w http.ResponseWriter, r *http.Request) {
			id, ok := documentID(w, r)
			if !ok {
				return
			}
			out, err := h.service.Get(r.Context(), auth.PrincipalFrom(r), id)
			respond(w, r, out, err)
		})
		r.Put("/documents/{documentID}", command(h, false, h.service.Update))
		r.Post("/documents/{documentID}/void", command(h, false, h.service.Void))
		r.Post("/documents/{documentID}/generate", command(h, false, h.service.Generate))
		r.Post("/documents/{documentID}/files", h.upload)
		r.Get("/documents/{documentID}/files/{fileID}", h.download)
		r.Get("/documents/{documentID}/history", func(w http.ResponseWriter, r *http.Request) {
			id, ok := documentID(w, r)
			if !ok {
				return
			}
			f, ok := filter(w, r)
			if !ok {
				return
			}
			out, err := h.service.History(r.Context(), auth.PrincipalFrom(r), id, f)
			respond(w, r, out, err)
		})
	})
}
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var v *ValidationError
	switch {
	case errors.As(err, &v):
		httpapi.WriteProblem(w, r, httpapi.ValidationProblem(httpapi.FieldError{Field: v.Field, Code: "invalid", Message: v.Message}))
	case errors.Is(err, ErrNotFound):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(404, "not_found", "Документ не найден."))
	case errors.Is(err, ErrConflict):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(409, "document_conflict", "Версия или исходные данные изменились. Перечитайте документ."))
	case errors.Is(err, ErrUnavailable):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(503, "documents_unavailable", "Документы временно недоступны."))
	default:
		auth.WriteError(w, r, err)
	}
}
func respond(w http.ResponseWriter, r *http.Request, out any, err error) {
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, out)
}
func documentID(w http.ResponseWriter, r *http.Request) (int32, bool) {
	n, err := strconv.ParseInt(chi.URLParam(r, "documentID"), 10, 32)
	if err != nil || n < 1 {
		// A malformed id in the address cannot name an existing record.
		writeError(w, r, ErrNotFound)
		return 0, false
	}
	return int32(n), true
}
func command[T any](h *Handler, create bool, fn func(context.Context, auth.Principal, int32, T) (Document, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var id int32
		if !create {
			var ok bool
			id, ok = documentID(w, r)
			if !ok {
				return
			}
		}
		var in T
		if problem := httpapi.DecodeJSONLimit(w, r, &in, 16<<10); problem != nil {
			httpapi.WriteProblem(w, r, problem)
			return
		}
		out, err := fn(r.Context(), auth.PrincipalFrom(r), id, in)
		if err != nil {
			writeError(w, r, err)
			return
		}
		status := 200
		if create {
			status = 201
			w.Header().Set("Location", "/api/v1/documents/"+strconv.Itoa(int(out.ID)))
		}
		httpapi.WriteJSON(w, status, out)
	}
}
func filter(w http.ResponseWriter, r *http.Request) (Filter, bool) {
	f := Filter{Limit: 20}
	values := r.URL.Query()
	for _, key := range []string{"after", "limit", "number", "type_id", "member_id", "dog_id", "event_id", "from", "to"} {
		if len(values[key]) > 1 {
			writeError(w, r, invalid("query", "Укажите каждый параметр один раз."))
			return f, false
		}
	}
	for _, e := range []struct {
		key    string
		target *int64
		max    int64
	}{{"after", &f.After, 1<<63 - 1}} {
		if raw, ok := values[e.key]; ok {
			v, err := strconv.ParseInt(raw[0], 10, 64)
			if err != nil || v < 0 || v > e.max {
				writeError(w, r, invalid(e.key, "Неверный числовой параметр."))
				return f, false
			}
			*e.target = v
		}
	}
	for _, key := range []string{"limit", "type_id", "member_id", "dog_id", "event_id"} {
		if raw, ok := values[key]; ok {
			v, err := strconv.ParseInt(raw[0], 10, 32)
			if err != nil || v < 1 {
				writeError(w, r, invalid(key, "Укажите положительное число."))
				return f, false
			}
			switch key {
			case "limit":
				f.Limit = int(v)
			case "type_id":
				f.TypeID = int32(v)
			case "member_id":
				f.MemberID = int32(v)
			case "event_id":
				f.EventID = int32(v)
			case "dog_id":
				f.DogID = int32(v)
			}
		}
	}
	f.Number = values.Get("number")
	if v, ok := values["from"]; ok {
		f.From = &v[0]
	}
	if v, ok := values["to"]; ok {
		f.To = &v[0]
	}
	return f, true
}
func (h *Handler) upload(w http.ResponseWriter, r *http.Request) {
	id, ok := documentID(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, filestore.MaxSize+(64<<10))
	reader, err := r.MultipartReader()
	if err != nil {
		httpapi.WriteProblem(w, r, httpapi.NewProblem(415, "unsupported_media_type", "Не удалось прочитать файл. Выберите его ещё раз и повторите."))
		return
	}
	var data []byte
	var name, media string
	var c Correction
	seen := map[string]bool{}
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			uploadError(w, r, err)
			return
		}
		key := part.FormName()
		if key != "file" && key != "version" && key != "reason" || seen[key] {
			part.Close()
			writeError(w, r, invalid("multipart", "Не удалось прочитать файл. Выберите его ещё раз и повторите."))
			return
		}
		seen[key] = true
		limit := int64(4096)
		if key == "file" {
			limit = filestore.MaxSize
		}
		b, err := io.ReadAll(io.LimitReader(part, limit+1))
		if err != nil {
			part.Close()
			uploadError(w, r, err)
			return
		}
		if int64(len(b)) > limit {
			part.Close()
			httpapi.WriteProblem(w, r, httpapi.NewProblem(413, "body_too_large", "Превышен размер файла или поля."))
			return
		}
		switch key {
		case "file":
			_, params, e := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
			if e != nil {
				part.Close()
				writeError(w, r, invalid("file", "Неверное имя файла."))
				return
			}
			name = params["filename"]
			media = part.Header.Get("Content-Type")
			data = b
		case "version":
			c.Version, err = strconv.ParseInt(string(b), 10, 64)
			if err != nil {
				part.Close()
				writeError(w, r, invalid("version", "Неверная версия."))
				return
			}
		case "reason":
			c.Reason = string(b)
		}
		part.Close()
	}
	if len(seen) != 3 {
		writeError(w, r, invalid("multipart", "Выберите файл и укажите причину."))
		return
	}
	out, err := h.service.Upload(r.Context(), auth.PrincipalFrom(r), id, c, name, media, data)
	respond(w, r, out, err)
}
func uploadError(w http.ResponseWriter, r *http.Request, err error) {
	var size *http.MaxBytesError
	if errors.As(err, &size) {
		httpapi.WriteProblem(w, r, httpapi.NewProblem(413, "body_too_large", "Превышен размер запроса."))
		return
	}
	httpapi.WriteProblem(w, r, httpapi.NewProblem(400, "invalid_json", "Не удалось прочитать файл. Выберите его ещё раз и повторите."))
}
func (h *Handler) download(w http.ResponseWriter, r *http.Request) {
	id, ok := documentID(w, r)
	if !ok {
		return
	}
	fid, err := strconv.ParseInt(chi.URLParam(r, "fileID"), 10, 64)
	if err != nil || fid < 1 {
		// A malformed id in the address cannot name an existing record.
		writeError(w, r, ErrNotFound)
		return
	}
	f, data, err := h.service.Download(r.Context(), auth.PrincipalFrom(r), id, fid)
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", f.MediaType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": f.Name}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.WriteHeader(200)
	_, _ = w.Write(data)
}
