package dogs

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/platform/httpapi"
	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
)

type Handler struct {
	service *Service
	account *auth.Handler
}

func NewHandler(service *Service, account *auth.Handler) *Handler { return &Handler{service, account} }
func (h *Handler) RegisterRoutes(router chi.Router) {
	router.Group(func(r chi.Router) {
		r.Use(httpapi.Protect, h.account.RequireAccount)
		r.Get("/dogs", h.list)
		r.Post("/dogs", h.create)
		r.Get("/dogs/{dogID}", h.get)
		r.Patch("/dogs/{dogID}", h.patch)
		r.Get("/dogs/{dogID}/history", h.history)
		r.Put("/dogs/{dogID}/owners", h.owners)
		r.Put("/dogs/{dogID}/registration", h.registration)
		r.Put("/dogs/{dogID}/pedigree", h.pedigree)
		r.Post("/dogs/{dogID}/titles", h.title)
		r.Put("/dogs/{dogID}/titles/{titleID}", h.updateTitle)
		r.Delete("/dogs/{dogID}/titles/{titleID}", h.correctTitle)
		r.Get("/dogs/{dogID}/photo", h.photo)
		r.Get("/dogs/{dogID}/photo/file", h.photoFile)
		r.Put("/dogs/{dogID}/photo", h.setPhoto)
		r.Delete("/dogs/{dogID}/photo", h.removePhoto)
		r.Get("/dog-dictionaries", h.dictionaries)
	})
}
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	if p := httpapi.DecodeJSONLimit(w, r, dst, 16<<10); p != nil {
		httpapi.WriteProblem(w, r, p)
		return false
	}
	return true
}
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var validation *ValidationError
	switch {
	case errors.As(err, &validation):
		fields := make([]httpapi.FieldError, 0, len(validation.Fields))
		for _, f := range validation.Fields {
			fields = append(fields, httpapi.FieldError{Field: f.Field, Code: "invalid", Message: f.Message})
		}
		slog.WarnContext(r.Context(), "dogs: ошибка заполнения полей",
			"request_id", chimiddleware.GetReqID(r.Context()), "code", "validation_failed", "errors", fields)
		httpapi.WriteProblem(w, r, httpapi.ValidationProblem(fields...))
	case errors.Is(err, ErrNotFound):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(404, "not_found", "Запись не найдена."))
	case errors.Is(err, ErrConflict):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(409, "dog_conflict", "Версия карточки устарела, идентификатор уже используется или титул уже записан. Обновите данные перед повторной попыткой."))
	case errors.Is(err, ErrUnavailable):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(503, "dogs_unavailable", "Сервис учёта собак временно недоступен."))
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
func positiveID(w http.ResponseWriter, r *http.Request, key string) (int32, bool) {
	v, err := strconv.ParseInt(chi.URLParam(r, key), 10, 32)
	if err != nil || v < 1 {
		writeError(w, r, invalid(key, "Укажите положительный идентификатор."))
		return 0, false
	}
	return int32(v), true
}
func queryNumber(r *http.Request, key string, fallback, max int64) (int64, error) {
	values, exists := r.URL.Query()[key]
	if !exists {
		return fallback, nil
	}
	if len(values) != 1 {
		return 0, invalid(key, "Укажите параметр один раз.")
	}
	n, err := strconv.ParseInt(values[0], 10, 64)
	if err != nil || n < 0 || n > max {
		return 0, invalid(key, "Недопустимое значение параметра страницы.")
	}
	return n, nil
}
func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	values := make(map[string]int64)
	for _, v := range []struct {
		name          string
		fallback, max int64
	}{{"after", 0, 1<<31 - 1}, {"limit", 50, 100}, {"breed_id", 0, 1<<31 - 1}, {"status_id", 0, 1<<31 - 1}, {"sex_id", 0, 1<<31 - 1}, {"owner_id", 0, 1<<31 - 1}} {
		n, err := queryNumber(r, v.name, v.fallback, v.max)
		if err != nil {
			writeError(w, r, err)
			return
		}
		values[v.name] = n
	}
	if len(r.URL.Query()["q"]) > 1 {
		writeError(w, r, invalid("q", "Укажите поисковый запрос один раз."))
		return
	}
	page, err := h.service.List(r.Context(), auth.PrincipalFrom(r), Filter{Query: r.URL.Query().Get("q"), After: int32(values["after"]), Limit: int(values["limit"]), BreedID: int32(values["breed_id"]), StatusID: int32(values["status_id"]), SexID: int32(values["sex_id"]), OwnerID: int32(values["owner_id"])})
	respond(w, r, page, err)
}
func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	var in CreateInput
	if !decode(w, r, &in) {
		return
	}
	d, err := h.service.Create(r.Context(), auth.PrincipalFrom(r), in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.Header().Set("Location", "/api/v1/dogs/"+strconv.Itoa(int(d.ID)))
	httpapi.WriteJSON(w, 201, d)
}
func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	d, err := h.service.Get(r.Context(), auth.PrincipalFrom(r), id)
	respond(w, r, d, err)
}
func (h *Handler) patch(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	var in PatchInput
	if !decode(w, r, &in) {
		return
	}
	d, err := h.service.Patch(r.Context(), auth.PrincipalFrom(r), id, in)
	respond(w, r, d, err)
}
func (h *Handler) owners(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	var in OwnersInput
	if !decode(w, r, &in) {
		return
	}
	d, err := h.service.SetOwners(r.Context(), auth.PrincipalFrom(r), id, in)
	respond(w, r, d, err)
}
func (h *Handler) pedigree(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	var in PedigreeInput
	if !decode(w, r, &in) {
		return
	}
	d, err := h.service.SetPedigree(r.Context(), auth.PrincipalFrom(r), id, in)
	respond(w, r, d, err)
}
func (h *Handler) title(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	var in TitleInput
	if !decode(w, r, &in) {
		return
	}
	d, err := h.service.AddTitle(r.Context(), auth.PrincipalFrom(r), id, in)
	respond(w, r, d, err)
}
func (h *Handler) updateTitle(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	titleID, ok := positiveID(w, r, "titleID")
	if !ok {
		return
	}
	var in TitleUpdateInput
	if !decode(w, r, &in) {
		return
	}
	d, err := h.service.UpdateTitle(r.Context(), auth.PrincipalFrom(r), id, titleID, in)
	respond(w, r, d, err)
}
func (h *Handler) correctTitle(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	titleID, ok := positiveID(w, r, "titleID")
	if !ok {
		return
	}
	var in CorrectionInput
	if !decode(w, r, &in) {
		return
	}
	d, err := h.service.CorrectTitle(r.Context(), auth.PrincipalFrom(r), id, titleID, in)
	respond(w, r, d, err)
}
func (h *Handler) history(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	after, err := queryNumber(r, "after", 0, 1<<63-1)
	if err != nil {
		writeError(w, r, err)
		return
	}
	limit, err := queryNumber(r, "limit", 50, 100)
	if err != nil {
		writeError(w, r, err)
		return
	}
	page, err := h.service.History(r.Context(), auth.PrincipalFrom(r), id, after, int(limit))
	respond(w, r, page, err)
}
func (h *Handler) dictionaries(w http.ResponseWriter, r *http.Request) {
	d, err := h.service.Dictionaries(r.Context(), auth.PrincipalFrom(r))
	respond(w, r, d, err)
}

func (h *Handler) registration(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "dogID")
	if !ok {
		return
	}
	var in RegistrationInput
	if problem := httpapi.DecodeJSONLimit(w, r, &in, 16<<10); problem != nil {
		httpapi.WriteProblem(w, r, problem)
		return
	}
	out, err := h.service.SetRegistrationDate(r.Context(), auth.PrincipalFrom(r), id, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, out)
}
