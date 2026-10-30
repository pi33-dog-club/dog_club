package veterinary

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/dogs"
	"dogclub.local/backend/internal/platform/httpapi"
	"github.com/go-chi/chi/v5"
)

type Handler struct {
	service *Service
	account *auth.Handler
}

func NewHandler(service *Service, account *auth.Handler) *Handler { return &Handler{service, account} }
func (h *Handler) RegisterRoutes(router chi.Router) {
	router.Group(func(r chi.Router) {
		r.Use(httpapi.Protect, h.account.RequireAccount)
		r.Get("/veterinary/dogs", h.patients)
		r.Get("/veterinary-dictionaries", h.dictionaries)
		r.Get("/vaccine-types/{typeID}", h.vaccineType)
		r.Get("/vaccine-types/{typeID}/history", h.vaccineHistory)
		r.Post("/vaccine-types", command(h, "", true, func(ctx context.Context, p auth.Principal, _ int32, _ int64, in VaccineTypeInput) (VaccineType, error) {
			return h.service.CreateVaccineType(ctx, p, in)
		}))
		r.Put("/vaccine-types/{typeID}", command(h, "typeID", false, func(ctx context.Context, p auth.Principal, _ int32, id int64, in VaccineTypeUpdate) (VaccineType, error) {
			return h.service.UpdateVaccineType(ctx, p, int32(id), in)
		}))
		r.Get("/dogs/{dogID}/examinations", collection(h, h.service.Examinations))
		r.Get("/dogs/{dogID}/vaccinations", collection(h, h.service.Vaccinations))
		r.Get("/dogs/{dogID}/clearances", collection(h, h.service.Clearances))
		r.Get("/dogs/{dogID}/veterinary-history", collection(h, h.service.History))
		r.Get("/dogs/{dogID}/examinations/{examinationID}", one(h, "examinationID", func(ctx context.Context, p auth.Principal, dogID int32, id int64) (Examination, error) {
			return h.service.GetExamination(ctx, p, dogID, int32(id))
		}))
		r.Get("/dogs/{dogID}/vaccinations/{vaccinationID}", one(h, "vaccinationID", func(ctx context.Context, p auth.Principal, dogID int32, id int64) (Vaccination, error) {
			return h.service.GetVaccination(ctx, p, dogID, int32(id))
		}))
		r.Get("/dogs/{dogID}/clearances/{clearanceID}", one(h, "clearanceID", h.service.GetClearance))
		r.Post("/dogs/{dogID}/examinations", command(h, "", true, func(ctx context.Context, p auth.Principal, dogID int32, _ int64, in ExaminationInput) (Examination, error) {
			return h.service.CreateExamination(ctx, p, dogID, in)
		}))
		r.Post("/dogs/{dogID}/vaccinations", command(h, "", true, func(ctx context.Context, p auth.Principal, dogID int32, _ int64, in VaccinationInput) (Vaccination, error) {
			return h.service.CreateVaccination(ctx, p, dogID, in)
		}))
		r.Post("/dogs/{dogID}/clearances", command(h, "", true, func(ctx context.Context, p auth.Principal, dogID int32, _ int64, in ClearanceInput) (Clearance, error) {
			return h.service.CreateClearance(ctx, p, dogID, in)
		}))
		r.Put("/dogs/{dogID}/examinations/{examinationID}", command(h, "examinationID", false, func(ctx context.Context, p auth.Principal, dogID int32, id int64, in ExaminationUpdate) (Examination, error) {
			return h.service.UpdateExamination(ctx, p, dogID, int32(id), in)
		}))
		r.Put("/dogs/{dogID}/vaccinations/{vaccinationID}", command(h, "vaccinationID", false, func(ctx context.Context, p auth.Principal, dogID int32, id int64, in VaccinationUpdate) (Vaccination, error) {
			return h.service.UpdateVaccination(ctx, p, dogID, int32(id), in)
		}))
		r.Put("/dogs/{dogID}/clearances/{clearanceID}", command(h, "clearanceID", false, h.service.UpdateClearance))
		for _, e := range []struct{ path, key, entity string }{{"examinations", "examinationID", "examination"}, {"vaccinations", "vaccinationID", "vaccination"}, {"clearances", "clearanceID", "clearance"}} {
			r.Post("/dogs/{dogID}/"+e.path+"/{"+e.key+"}/void", command(h, e.key, false, func(ctx context.Context, p auth.Principal, dogID int32, id int64, in CorrectionInput) (any, error) {
				return h.service.Void(ctx, p, dogID, e.entity, id, in)
			}))
		}
		r.Get("/dogs/{dogID}/medical-status", h.medicalStatus)
	})
}
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var v *ValidationError
	switch {
	case errors.As(err, &v):
		fields := make([]httpapi.FieldError, 0, len(v.Fields))
		for _, f := range v.Fields {
			fields = append(fields, httpapi.FieldError{Field: f.Field, Code: "invalid", Message: f.Message})
		}
		httpapi.WriteProblem(w, r, httpapi.ValidationProblem(fields...))
	case errors.Is(err, ErrNotFound):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(404, "not_found", "Запись не найдена."))
	case errors.Is(err, ErrConflict):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(409, "veterinary_conflict", "Версия записи устарела или запись уже отмечена недействительной. Перечитайте данные."))
	case errors.Is(err, ErrUnavailable):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(503, "veterinary_unavailable", "Ветеринарный учёт временно недоступен."))
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
	bits := 32
	if key == "clearanceID" {
		bits = 64
	}
	id, err := strconv.ParseInt(chi.URLParam(r, key), 10, bits)
	if err != nil || id < 1 {
		// A malformed id in the address cannot name an existing record.
		writeError(w, r, ErrNotFound)
		return 0, false
	}
	return id, true
}
func dogID(w http.ResponseWriter, r *http.Request) (int32, bool) {
	id, ok := pathID(w, r, "dogID")
	return int32(id), ok
}
func queryNumber(r *http.Request, key string, fallback, max int64) (int64, error) {
	values, ok := r.URL.Query()[key]
	if !ok {
		return fallback, nil
	}
	if len(values) != 1 {
		return 0, invalid(key, "Укажите параметр один раз.")
	}
	v, err := strconv.ParseInt(values[0], 10, 64)
	if err != nil || v < 0 || v > max {
		return 0, invalid(key, "Недопустимое значение параметра страницы.")
	}
	return v, nil
}
func page(w http.ResponseWriter, r *http.Request) (PageFilter, bool) {
	after, err := queryNumber(r, "after", 0, 1<<63-1)
	if err != nil {
		writeError(w, r, err)
		return PageFilter{}, false
	}
	limit, err := queryNumber(r, "limit", 50, 100)
	if err != nil {
		writeError(w, r, err)
		return PageFilter{}, false
	}
	return PageFilter{after, int(limit)}, true
}
func collection[T any](h *Handler, fn func(context.Context, auth.Principal, int32, PageFilter) (Page[T], error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := dogID(w, r)
		if !ok {
			return
		}
		f, ok := page(w, r)
		if !ok {
			return
		}
		out, err := fn(r.Context(), auth.PrincipalFrom(r), id, f)
		respond(w, r, out, err)
	}
}
func one[T any](h *Handler, key string, fn func(context.Context, auth.Principal, int32, int64) (T, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dog, ok := dogID(w, r)
		if !ok {
			return
		}
		id, ok := pathID(w, r, key)
		if !ok {
			return
		}
		out, err := fn(r.Context(), auth.PrincipalFrom(r), dog, id)
		respond(w, r, out, err)
	}
}
func command[I, O any](h *Handler, key string, create bool, fn func(context.Context, auth.Principal, int32, int64, I) (O, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var dog int32
		if chi.URLParam(r, "dogID") != "" {
			id, ok := dogID(w, r)
			if !ok {
				return
			}
			dog = id
		}
		var id int64
		if key != "" {
			v, ok := pathID(w, r, key)
			if !ok {
				return
			}
			id = v
		}
		var in I
		if problem := httpapi.DecodeJSONLimit(w, r, &in, 16<<10); problem != nil {
			httpapi.WriteProblem(w, r, problem)
			return
		}
		out, err := fn(r.Context(), auth.PrincipalFrom(r), dog, id, in)
		if err != nil {
			writeError(w, r, err)
			return
		}
		status := 200
		if create {
			status = 201
			var path string
			prefix := "/api/v1/dogs/" + strconv.Itoa(int(dog))
			switch v := any(out).(type) {
			case Examination:
				path = prefix + "/examinations/" + strconv.Itoa(int(v.ID))
			case Vaccination:
				path = prefix + "/vaccinations/" + strconv.Itoa(int(v.ID))
			case Clearance:
				path = prefix + "/clearances/" + strconv.FormatInt(v.ID, 10)
			case VaccineType:
				path = "/api/v1/vaccine-types/" + strconv.Itoa(int(v.ID))
			}
			if path != "" {
				w.Header().Set("Location", path)
			}
		}
		httpapi.WriteJSON(w, status, out)
	}
}
func (h *Handler) patients(w http.ResponseWriter, r *http.Request) {
	values := map[string]int64{}
	for _, v := range []struct {
		key           string
		fallback, max int64
	}{{"after", 0, 2147483647}, {"limit", 50, 100}, {"breed_id", 0, 2147483647}, {"status_id", 0, 2147483647}, {"owner_id", 0, 2147483647}} {
		n, err := queryNumber(r, v.key, v.fallback, v.max)
		if err != nil {
			writeError(w, r, err)
			return
		}
		values[v.key] = n
	}
	if len(r.URL.Query()["q"]) > 1 {
		writeError(w, r, invalid("q", "Укажите поиск один раз."))
		return
	}
	out, err := h.service.Patients(r.Context(), auth.PrincipalFrom(r), dogs.Filter{Query: r.URL.Query().Get("q"), After: int32(values["after"]), Limit: int(values["limit"]), BreedID: int32(values["breed_id"]), StatusID: int32(values["status_id"]), OwnerID: int32(values["owner_id"])})
	respond(w, r, out, err)
}
func (h *Handler) dictionaries(w http.ResponseWriter, r *http.Request) {
	out, err := h.service.Dictionaries(r.Context(), auth.PrincipalFrom(r))
	respond(w, r, out, err)
}
func (h *Handler) vaccineType(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "typeID")
	if !ok {
		return
	}
	out, err := h.service.GetVaccineType(r.Context(), auth.PrincipalFrom(r), int32(id))
	respond(w, r, out, err)
}
func (h *Handler) vaccineHistory(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "typeID")
	if !ok {
		return
	}
	f, ok := page(w, r)
	if !ok {
		return
	}
	out, err := h.service.VaccineTypeHistory(r.Context(), auth.PrincipalFrom(r), int32(id), f)
	respond(w, r, out, err)
}
func (h *Handler) medicalStatus(w http.ResponseWriter, r *http.Request) {
	id, ok := dogID(w, r)
	if !ok {
		return
	}
	out, err := h.service.MedicalStatus(r.Context(), auth.PrincipalFrom(r), id)
	respond(w, r, out, err)
}
