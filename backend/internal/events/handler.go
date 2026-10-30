package events

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

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
		r.Get("/event-dictionaries", func(w http.ResponseWriter, r *http.Request) {
			out, err := h.service.Dictionaries(r.Context(), auth.PrincipalFrom(r))
			respond(w, r, out, err)
		})
		r.Get("/event-experts", func(w http.ResponseWriter, r *http.Request) {
			out, err := h.service.ExpertOptions(r.Context(), auth.PrincipalFrom(r))
			respond(w, r, out, err)
		})
		r.Get("/events/dogs", h.dogs)
		r.Get("/event-venues", func(w http.ResponseWriter, r *http.Request) {
			f, ok := filter(w, r, 64)
			if !ok {
				return
			}
			out, err := h.service.Venues(r.Context(), auth.PrincipalFrom(r), f)
			respond(w, r, out, err)
		})
		r.Post("/event-venues", command(h, "", true, func(ctx context.Context, p auth.Principal, _ int32, _ int64, in VenueInput) (Venue, error) {
			return h.service.CreateVenue(ctx, p, in)
		}))
		r.Get("/event-venues/{venueID}", one(h, "venueID", func(ctx context.Context, p auth.Principal, _ int32, id int64) (Venue, error) {
			return h.service.Venue(ctx, p, id)
		}))
		r.Put("/event-venues/{venueID}", command(h, "venueID", false, func(ctx context.Context, p auth.Principal, _ int32, id int64, in VenueUpdate) (Venue, error) {
			return h.service.UpdateVenue(ctx, p, id, in)
		}))
		r.Get("/event-venues/{venueID}/history", history(h, "venue", "venueID"))
		r.Get("/events", func(w http.ResponseWriter, r *http.Request) {
			f, ok := filter(w, r, 32)
			if !ok {
				return
			}
			out, err := h.service.Events(r.Context(), auth.PrincipalFrom(r), f)
			respond(w, r, out, err)
		})
		r.Post("/events", command(h, "", true, func(ctx context.Context, p auth.Principal, _ int32, _ int64, in EventInput) (Event, error) {
			return h.service.CreateEvent(ctx, p, in)
		}))
		r.Get("/events/{eventID}", one(h, "", func(ctx context.Context, p auth.Principal, id int32, _ int64) (Event, error) {
			return h.service.Event(ctx, p, id)
		}))
		r.Put("/events/{eventID}", command(h, "", false, func(ctx context.Context, p auth.Principal, id int32, _ int64, in EventUpdate) (Event, error) {
			return h.service.UpdateEvent(ctx, p, id, in)
		}))
		r.Post("/events/{eventID}/state", command(h, "", false, func(ctx context.Context, p auth.Principal, id int32, _ int64, in StateInput) (Event, error) {
			return h.service.SetState(ctx, p, id, in)
		}))
		r.Put("/events/{eventID}/experts", command(h, "", false, func(ctx context.Context, p auth.Principal, id int32, _ int64, in ExpertsInput) (Event, error) {
			return h.service.SetExperts(ctx, p, id, in)
		}))
		r.Post("/events/{eventID}/classes", command(h, "", true, func(ctx context.Context, p auth.Principal, e int32, _ int64, in ClassCommand) (Class, error) {
			return h.service.SaveClass(ctx, p, e, 0, in)
		}))
		r.Put("/events/{eventID}/classes/{classID}", command(h, "classID", false, h.service.SaveClass))
		r.Get("/events/{eventID}/classes/{classID}", one(h, "classID", h.service.Class))
		r.Post("/events/{eventID}/schedule", command(h, "", true, func(ctx context.Context, p auth.Principal, e int32, _ int64, in ScheduleCommand) (Schedule, error) {
			return h.service.SaveSchedule(ctx, p, e, 0, in)
		}))
		r.Put("/events/{eventID}/schedule/{scheduleID}", command(h, "scheduleID", false, h.service.SaveSchedule))
		r.Get("/events/{eventID}/schedule/{scheduleID}", one(h, "scheduleID", h.service.Schedule))
		r.Get("/events/{eventID}/registrations", collection(h, false, h.service.Registrations))
		r.Post("/events/{eventID}/registrations", command(h, "", true, func(ctx context.Context, p auth.Principal, e int32, _ int64, in RegistrationInput) (Registration, error) {
			return h.service.CreateRegistration(ctx, p, e, in)
		}))
		r.Get("/events/{eventID}/registrations/{registrationID}", one(h, "registrationID", h.service.Registration))
		r.Put("/events/{eventID}/registrations/{registrationID}", command(h, "registrationID", false, h.service.UpdateRegistration))
		r.Get("/events/{eventID}/registrations/{registrationID}/eligibility", one(h, "registrationID", h.service.Eligibility))
		r.Post("/events/{eventID}/registrations/{registrationID}/qualify", command(h, "registrationID", false, h.service.Qualify))
		r.Post("/events/{eventID}/registrations/{registrationID}/attend", command(h, "registrationID", false, h.service.Attend))
		r.Post("/events/{eventID}/registrations/{registrationID}/cancel", command(h, "registrationID", false, h.service.CancelRegistration))
		r.Post("/events/{eventID}/registrations/{registrationID}/result", command(h, "registrationID", true, h.service.CreateResult))
		r.Get("/events/{eventID}/results", collection(h, true, h.service.Results))
		r.Get("/events/{eventID}/results/{resultID}", one(h, "resultID", func(ctx context.Context, p auth.Principal, e int32, id int64) (Result, error) {
			return h.service.Result(ctx, p, e, int32(id))
		}))
		r.Put("/events/{eventID}/results/{resultID}", command(h, "resultID", false, func(ctx context.Context, p auth.Principal, e int32, id int64, in ResultUpdate) (Result, error) {
			return h.service.UpdateResult(ctx, p, e, int32(id), in)
		}))
		r.Post("/events/{eventID}/results/{resultID}/void", command(h, "resultID", false, func(ctx context.Context, p auth.Principal, e int32, id int64, in Correction) (Result, error) {
			return h.service.VoidResult(ctx, p, e, int32(id), in)
		}))
		r.Get("/events/{eventID}/history", history(h, "event", ""))
		r.Get("/events/{eventID}/registrations/{registrationID}/history", history(h, "registration", "registrationID"))
		r.Get("/events/{eventID}/results/{resultID}/history", history(h, "result", "resultID"))
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
		httpapi.WriteProblem(w, r, httpapi.NewProblem(409, "event_conflict", "Версия или состояние изменились. Перечитайте запись."))
	case errors.Is(err, ErrUnavailable):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(503, "events_unavailable", "Учёт мероприятий временно недоступен."))
	default:
		auth.WriteError(w, r, err)
	}
}
func respond(w http.ResponseWriter, r *http.Request, value any, err error) {
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, value)
}
func pathID(w http.ResponseWriter, r *http.Request, key string) (int64, bool) {
	bits := 64
	if key == "eventID" || key == "resultID" {
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
func routeIDs(w http.ResponseWriter, r *http.Request, key string) (int32, int64, bool) {
	var eventID int32
	var id int64
	if chi.URLParam(r, "eventID") != "" {
		value, ok := pathID(w, r, "eventID")
		if !ok {
			return 0, 0, false
		}
		eventID = int32(value)
	}
	if key != "" {
		value, ok := pathID(w, r, key)
		if !ok {
			return 0, 0, false
		}
		id = value
	}
	return eventID, id, true
}
func one[T any](h *Handler, key string, fn func(context.Context, auth.Principal, int32, int64) (T, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		e, id, ok := routeIDs(w, r, key)
		if !ok {
			return
		}
		out, err := fn(r.Context(), auth.PrincipalFrom(r), e, id)
		respond(w, r, out, err)
	}
}
func command[I, O any](h *Handler, key string, create bool, fn func(context.Context, auth.Principal, int32, int64, I) (O, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		eventID, id, ok := routeIDs(w, r, key)
		if !ok {
			return
		}
		var in I
		if problem := httpapi.DecodeJSONLimit(w, r, &in, 16<<10); problem != nil {
			httpapi.WriteProblem(w, r, problem)
			return
		}
		out, err := fn(r.Context(), auth.PrincipalFrom(r), eventID, id, in)
		if err != nil {
			writeError(w, r, err)
			return
		}
		status := 200
		if create {
			status = 201
			prefix := "/api/v1/events/" + strconv.Itoa(int(eventID))
			var path string
			switch v := any(out).(type) {
			case Venue:
				path = "/api/v1/event-venues/" + strconv.FormatInt(v.ID, 10)
			case Event:
				path = "/api/v1/events/" + strconv.Itoa(int(v.ID))
			case Class:
				path = prefix + "/classes/" + strconv.FormatInt(v.ID, 10)
			case Schedule:
				path = prefix + "/schedule/" + strconv.FormatInt(v.ID, 10)
			case Registration:
				path = prefix + "/registrations/" + strconv.FormatInt(v.ID, 10)
			case Result:
				path = prefix + "/results/" + strconv.Itoa(int(v.ID))
			}
			w.Header().Set("Location", path)
		}
		httpapi.WriteJSON(w, status, out)
	}
}
func number(r *http.Request, key string, fallback, max int64) (int64, error) {
	v, ok := r.URL.Query()[key]
	if !ok {
		return fallback, nil
	}
	if len(v) != 1 {
		return 0, invalid(key, "Укажите параметр один раз.")
	}
	n, err := strconv.ParseInt(v[0], 10, 64)
	if err != nil || n < 0 || n > max {
		return 0, invalid(key, "Недопустимое значение параметра.")
	}
	return n, nil
}
func filter(w http.ResponseWriter, r *http.Request, bits int) (Filter, bool) {
	max := int64(1<<63 - 1)
	if bits == 32 {
		max = 1<<31 - 1
	}
	after, err := number(r, "after", 0, max)
	if err != nil {
		writeError(w, r, err)
		return Filter{}, false
	}
	limit, err := number(r, "limit", 50, 100)
	if err != nil || limit < 1 {
		writeError(w, r, invalid("limit", "Не удалось загрузить список. Обновите страницу."))
		return Filter{}, false
	}
	typeID, err := number(r, "type_id", 0, 1<<31-1)
	if err != nil {
		writeError(w, r, err)
		return Filter{}, false
	}
	dogID, err := number(r, "dog_id", 0, 1<<31-1)
	if err != nil {
		writeError(w, r, err)
		return Filter{}, false
	}
	if len(r.URL.Query()["q"]) > 1 || len(r.URL.Query()["status"]) > 1 {
		writeError(w, r, invalid("query", "Укажите параметры один раз."))
		return Filter{}, false
	}
	f := Filter{After: after, Limit: int(limit), Query: r.URL.Query().Get("q"), Status: r.URL.Query().Get("status"), TypeID: int32(typeID), DogID: int32(dogID)}
	for _, entry := range []struct {
		key    string
		target **time.Time
	}{{"from", &f.From}, {"to", &f.To}} {
		if values, exists := r.URL.Query()[entry.key]; exists {
			if len(values) != 1 {
				writeError(w, r, invalid(entry.key, "Укажите параметр один раз."))
				return Filter{}, false
			}
			date, err := time.Parse(time.RFC3339, values[0])
			if err != nil || date.Year() < 1 || date.UTC().Year() < 1 || date.UTC().Year() > 9999 {
				writeError(w, r, invalid(entry.key, "Проверьте дату и время в фильтре."))
				return Filter{}, false
			}
			*entry.target = &date
		}
	}
	return f, true
}
func collection[T any](h *Handler, small bool, fn func(context.Context, auth.Principal, int32, Filter) (Page[T], error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		e, _, ok := routeIDs(w, r, "")
		if !ok {
			return
		}
		bits := 64
		if small {
			bits = 32
		}
		f, ok := filter(w, r, bits)
		if !ok {
			return
		}
		out, err := fn(r.Context(), auth.PrincipalFrom(r), e, f)
		respond(w, r, out, err)
	}
}
func history(h *Handler, entity, key string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		e, id, ok := routeIDs(w, r, key)
		if !ok {
			return
		}
		f, ok := filter(w, r, 64)
		if !ok {
			return
		}
		out, err := h.service.History(r.Context(), auth.PrincipalFrom(r), e, entity, id, f)
		respond(w, r, out, err)
	}
}
func (h *Handler) dogs(w http.ResponseWriter, r *http.Request) {
	f, ok := filter(w, r, 32)
	if !ok {
		return
	}
	breed, err := number(r, "breed_id", 0, 1<<31-1)
	if err != nil {
		writeError(w, r, err)
		return
	}
	out, err := h.service.Dogs(r.Context(), auth.PrincipalFrom(r), dogs.Filter{After: int32(f.After), Limit: f.Limit, Query: f.Query, BreedID: int32(breed)})
	respond(w, r, out, err)
}
