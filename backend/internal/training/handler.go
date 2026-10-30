package training

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"dogclub.local/backend/internal/auth"
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
		r.Get("/training-types", func(w http.ResponseWriter, r *http.Request) {
			if _, ok := query(w, r, "none"); !ok {
				return
			}
			out, err := h.service.Types(r.Context(), auth.PrincipalFrom(r))
			respond(w, r, out, err)
		})
		r.Get("/training-instructors", func(w http.ResponseWriter, r *http.Request) {
			f, ok := query(w, r, "instructors")
			if !ok {
				return
			}
			out, err := h.service.Instructors(r.Context(), auth.PrincipalFrom(r), f)
			respond(w, r, out, err)
		})
		r.Put("/training-instructors/{profileID}", command(h, false, func(ctx context.Context, p auth.Principal, _ int32, _ int32, in GrantInput, r *http.Request) (Instructor, error) {
			return h.service.SetInstructor(ctx, p, chi.URLParam(r, "profileID"), in)
		}))
		r.Get("/training-instructors/{profileID}/history", func(w http.ResponseWriter, r *http.Request) {
			f, ok := query(w, r, "history")
			if !ok {
				return
			}
			out, err := h.service.InstructorHistory(r.Context(), auth.PrincipalFrom(r), chi.URLParam(r, "profileID"), f)
			respond(w, r, out, err)
		})
		r.Get("/training-sessions", func(w http.ResponseWriter, r *http.Request) {
			f, ok := query(w, r, "sessions")
			if !ok {
				return
			}
			out, err := h.service.List(r.Context(), auth.PrincipalFrom(r), f)
			respond(w, r, out, err)
		})
		r.Post("/dogs/{dogID}/training-sessions", command(h, true, func(ctx context.Context, p auth.Principal, dog, id int32, in Input, _ *http.Request) (Session, error) {
			return h.service.Create(ctx, p, dog, in)
		}))
		r.Get("/dogs/{dogID}/training-sessions/{sessionID}", func(w http.ResponseWriter, r *http.Request) {
			dog, id, ok := pathIDs(w, r)
			if !ok {
				return
			}
			if _, ok = query(w, r, "none"); !ok {
				return
			}
			out, err := h.service.Get(r.Context(), auth.PrincipalFrom(r), dog, id)
			respond(w, r, out, err)
		})
		r.Put("/dogs/{dogID}/training-sessions/{sessionID}", command(h, false, func(ctx context.Context, p auth.Principal, dog, id int32, in Update, _ *http.Request) (Session, error) {
			return h.service.Update(ctx, p, dog, id, in)
		}))
		r.Post("/dogs/{dogID}/training-sessions/{sessionID}/void", command(h, false, func(ctx context.Context, p auth.Principal, dog, id int32, in Correction, _ *http.Request) (Session, error) {
			return h.service.Void(ctx, p, dog, id, in)
		}))
		r.Get("/dogs/{dogID}/training-sessions/{sessionID}/history", func(w http.ResponseWriter, r *http.Request) {
			dog, id, ok := pathIDs(w, r)
			if !ok {
				return
			}
			f, ok := query(w, r, "history")
			if !ok {
				return
			}
			out, err := h.service.History(r.Context(), auth.PrincipalFrom(r), dog, id, f)
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
		httpapi.WriteProblem(w, r, httpapi.NewProblem(404, "training_not_found", "Запись дрессировки не найдена."))
	case errors.Is(err, ErrConflict):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(409, "training_conflict", "Версия, состояние или запись занятия конфликтуют."))
	case errors.Is(err, ErrUnavailable):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(503, "training_unavailable", "Учёт дрессировки временно недоступен."))
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
func pathIDs(w http.ResponseWriter, r *http.Request) (int32, int32, bool) {
	var dog, id int32
	for _, k := range []string{"dogID", "sessionID"} {
		raw := chi.URLParam(r, k)
		if raw == "" {
			continue
		}
		v, err := strconv.ParseInt(raw, 10, 32)
		if err != nil || v < 1 {
			// A malformed id in the address cannot name an existing record.
			writeError(w, r, ErrNotFound)
			return 0, 0, false
		}
		if k == "dogID" {
			dog = int32(v)
		} else {
			id = int32(v)
		}
	}
	return dog, id, true
}
func command[I, O any](h *Handler, create bool, fn func(context.Context, auth.Principal, int32, int32, I, *http.Request) (O, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dog, id, ok := pathIDs(w, r)
		if !ok {
			return
		}
		if _, ok = query(w, r, "none"); !ok {
			return
		}
		var in I
		if problem := httpapi.DecodeJSONLimit(w, r, &in, 16<<10); problem != nil {
			httpapi.WriteProblem(w, r, problem)
			return
		}
		out, err := fn(r.Context(), auth.PrincipalFrom(r), dog, id, in, r)
		if err != nil {
			writeError(w, r, err)
			return
		}
		status := 200
		if create {
			status = 201
			if v, ok := any(out).(Session); ok {
				w.Header().Set("Location", fmt.Sprintf("/api/v1/dogs/%d/training-sessions/%d", v.DogID, v.ID))
			}
		}
		httpapi.WriteJSON(w, status, out)
	}
}
func query(w http.ResponseWriter, r *http.Request, kind string) (Filter, bool) {
	f := Filter{Limit: 50}
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		writeError(w, r, invalid("query", "Некорректная строка запроса."))
		return f, false
	}
	allowed := map[string]bool{}
	if kind != "none" {
		allowed["after"] = true
		allowed["limit"] = true
	}
	if kind == "sessions" {
		for _, k := range []string{"dog_id", "type_id", "instructor_profile_id", "from", "to"} {
			allowed[k] = true
		}
	}
	for key, v := range q {
		if !allowed[key] || len(v) != 1 || v[0] == "" {
			writeError(w, r, invalid("query", "Укажите только известные непустые параметры по одному разу."))
			return f, false
		}
	}
	for _, key := range []string{"after", "limit", "dog_id", "type_id"} {
		raw := q.Get(key)
		if raw == "" {
			continue
		}
		if key == "after" && kind == "instructors" {
			f.AfterProfile = raw
			continue
		}
		v, e := strconv.ParseInt(raw, 10, 64)
		if e != nil || v < 0 || (key == "dog_id" || key == "type_id") && (v == 0 || v > 2147483647) {
			writeError(w, r, invalid(key, "Некорректный числовой параметр."))
			return f, false
		}
		switch key {
		case "after":
			f.After = v
		case "limit":
			if v < 1 || v > 100 {
				writeError(w, r, invalid("limit", "Не удалось загрузить список. Обновите страницу."))
				return f, false
			}
			f.Limit = int(v)
		case "dog_id":
			f.DogID = int32(v)
		case "type_id":
			f.TypeID = int32(v)
		}
	}
	f.InstructorProfileID = q.Get("instructor_profile_id")
	for _, key := range []string{"from", "to"} {
		if raw := q.Get(key); raw != "" {
			v, e := time.Parse(time.RFC3339Nano, raw)
			if e != nil || v.UTC().Year() < 1 || v.UTC().Year() > 9999 {
				writeError(w, r, invalid(key, "Проверьте дату и время в фильтре."))
				return f, false
			}
			if key == "from" {
				f.From = &v
			} else {
				f.To = &v
			}
		}
	}
	if err := validFilter(f); err != nil {
		writeError(w, r, err)
		return f, false
	}
	return f, true
}
