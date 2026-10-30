package breeding

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/dogs"
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
		r.Get("/breeding/dogs", h.patients)
		r.Get("/breeding/dogs/{dogID}/mate-candidates", func(w http.ResponseWriter, r *http.Request) {
			id, ok := pathID(w, r, "dogID")
			if !ok {
				return
			}
			out, err := h.service.MateCandidates(r.Context(), auth.PrincipalFrom(r), int32(id))
			respond(w, r, out, err)
		})
		for _, e := range []struct{ path, entity string }{{"breeding-requests", "request"}, {"breedings", "breeding"}, {"litters", "litter"}} {
			r.Get("/"+e.path, func(w http.ResponseWriter, r *http.Request) {
				f, ok := filter(w, r)
				if !ok {
					return
				}
				out, err := h.service.List(r.Context(), auth.PrincipalFrom(r), e.entity, f)
				respond(w, r, out, err)
			})
			r.Get("/"+e.path+"/{id}", func(w http.ResponseWriter, r *http.Request) {
				id, ok := pathID(w, r, "id")
				if !ok {
					return
				}
				out, err := h.service.Get(r.Context(), auth.PrincipalFrom(r), e.entity, id)
				respond(w, r, out, err)
			})
			r.Get("/"+e.path+"/{id}/history", func(w http.ResponseWriter, r *http.Request) {
				id, ok := pathID(w, r, "id")
				if !ok {
					return
				}
				f, ok := filter(w, r)
				if !ok {
					return
				}
				out, err := h.service.History(r.Context(), auth.PrincipalFrom(r), e.entity, id, f)
				respond(w, r, out, err)
			})
		}
		r.Post("/breeding-requests", command(h, true, func(ctx context.Context, p auth.Principal, _ int64, in RequestInput) (Request, error) {
			return h.service.CreateRequest(ctx, p, in)
		}))
		r.Put("/breeding-requests/{id}", command(h, false, h.service.UpdateRequest))
		r.Post("/breeding-requests/{id}/cancel", command(h, false, h.service.Cancel))
		r.Get("/breeding-requests/{id}/check", func(w http.ResponseWriter, r *http.Request) {
			id, ok := pathID(w, r, "id")
			if !ok {
				return
			}
			out, err := h.service.Check(r.Context(), auth.PrincipalFrom(r), id)
			respond(w, r, out, err)
		})
		r.Get("/breeding-requests/{id}/decisions", func(w http.ResponseWriter, r *http.Request) {
			id, ok := pathID(w, r, "id")
			if !ok {
				return
			}
			f, ok := filter(w, r)
			if !ok {
				return
			}
			out, err := h.service.Decisions(r.Context(), auth.PrincipalFrom(r), id, f)
			respond(w, r, out, err)
		})
		r.Post("/breeding-requests/{id}/decisions", command(h, false, h.service.Decide))
		r.Post("/breeding-requests/{id}/perform", command(h, true, h.service.Perform))
		r.Put("/breedings/{id}", command(h, false, h.service.UpdateMating))
		r.Post("/litters", command(h, true, func(ctx context.Context, p auth.Principal, _ int64, in LitterInput) (Litter, error) {
			return h.service.CreateLitter(ctx, p, in)
		}))
		r.Put("/litters/{id}", command(h, false, h.service.UpdateLitter))
		r.Post("/litters/{id}/puppies", command(h, false, h.service.RegisterPuppy))
		r.Post("/litters/{id}/puppies/link", command(h, false, h.service.LinkPuppy))
		r.Post("/litters/{id}/puppies/{dogID}/unlink", func(w http.ResponseWriter, r *http.Request) {
			id, ok := pathID(w, r, "id")
			if !ok {
				return
			}
			dog, ok := pathID(w, r, "dogID")
			if !ok {
				return
			}
			var in Correction
			if problem := httpapi.DecodeJSONLimit(w, r, &in, 16<<10); problem != nil {
				httpapi.WriteProblem(w, r, problem)
				return
			}
			out, err := h.service.UnlinkPuppy(r.Context(), auth.PrincipalFrom(r), id, int32(dog), in)
			respond(w, r, out, err)
		})
	})
}
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var v *ValidationError
	switch {
	case errors.As(err, &v):
		fields := []httpapi.FieldError{}
		for _, f := range v.Fields {
			fields = append(fields, httpapi.FieldError{Field: f.Field, Code: "invalid", Message: f.Message})
		}
		httpapi.WriteProblem(w, r, httpapi.ValidationProblem(fields...))
	case errors.Is(err, ErrNotFound):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(404, "not_found", "Запись не найдена."))
	case errors.Is(err, ErrConflict):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(409, "breeding_conflict", "Версия устарела или состояние записи изменилось. Перечитайте данные."))
	case errors.Is(err, ErrUnavailable):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(503, "breeding_unavailable", "Племенной учёт временно недоступен."))
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
func pathID(w http.ResponseWriter, r *http.Request, key string) (int64, bool) {
	bits := 64
	if key == "dogID" {
		bits = 32
	}
	if key == "id" && strings.HasPrefix(r.URL.Path, "/api/v1/breedings/") {
		bits = 32
	}
	id, err := strconv.ParseInt(chi.URLParam(r, key), 10, bits)
	if err != nil || id < 1 {
		// A malformed id in the address cannot name an existing record.
		writeError(w, r, ErrNotFound)
		return 0, false
	}
	return id, true
}
func number(r *http.Request, key string, fallback, max int64) (int64, error) {
	values, ok := r.URL.Query()[key]
	if !ok {
		return fallback, nil
	}
	if len(values) != 1 {
		return 0, invalid(key, "Укажите параметр один раз.")
	}
	n, err := strconv.ParseInt(values[0], 10, 64)
	if err != nil || n < 0 || n > max {
		return 0, invalid(key, "Недопустимое значение параметра.")
	}
	return n, nil
}
func filter(w http.ResponseWriter, r *http.Request) (Filter, bool) {
	a, err := number(r, "after", 0, 1<<63-1)
	if err != nil {
		writeError(w, r, err)
		return Filter{}, false
	}
	l, err := number(r, "limit", 50, 100)
	if err != nil || l < 1 {
		writeError(w, r, invalid("limit", "Не удалось загрузить список. Обновите страницу."))
		return Filter{}, false
	}
	d, err := number(r, "dog_id", 0, 1<<31-1)
	if err != nil {
		writeError(w, r, err)
		return Filter{}, false
	}
	return Filter{a, int(l), int32(d)}, true
}
func command[I, O any](h *Handler, create bool, fn func(context.Context, auth.Principal, int64, I) (O, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var id int64
		if chi.URLParam(r, "id") != "" {
			var ok bool
			id, ok = pathID(w, r, "id")
			if !ok {
				return
			}
		}
		var in I
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
			var path string
			var oid int64
			switch v := any(out).(type) {
			case Request:
				path = "breeding-requests"
				oid = v.ID
			case Mating:
				path = "breedings"
				oid = v.ID
			case Litter:
				path = "litters"
				oid = v.ID
			}
			w.Header().Set("Location", "/api/v1/"+path+"/"+strconv.FormatInt(oid, 10))
		}
		httpapi.WriteJSON(w, status, out)
	}
}
func (h *Handler) patients(w http.ResponseWriter, r *http.Request) {
	f, ok := filter(w, r)
	if !ok {
		return
	}
	if f.After > 1<<31-1 {
		writeError(w, r, invalid("after", "Не удалось загрузить список. Обновите страницу."))
		return
	}
	breed, err := number(r, "breed_id", 0, 1<<31-1)
	if err != nil {
		writeError(w, r, err)
		return
	}
	if len(r.URL.Query()["q"]) > 1 {
		writeError(w, r, invalid("q", "Укажите поиск один раз."))
		return
	}
	out, err := h.service.Patients(r.Context(), auth.PrincipalFrom(r), dogs.Filter{After: int32(f.After), Limit: f.Limit, BreedID: int32(breed), Query: r.URL.Query().Get("q")})
	respond(w, r, out, err)
}
