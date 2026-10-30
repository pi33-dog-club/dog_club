package members

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
		r.Get("/members", h.list)
		r.Post("/members", h.create)
		r.Get("/members/me", h.me)
		r.Get("/members/{memberID}", h.get)
		r.Patch("/members/{memberID}", h.patch)
		r.Get("/members/{memberID}/history", h.history)
		r.Post("/members/{memberID}/contacts", h.contact)
		r.Put("/members/{memberID}/contacts/{contactID}", h.contact)
		r.Delete("/members/{memberID}/contacts/{contactID}", h.deleteContact)
		r.Post("/members/{memberID}/addresses", h.address)
		r.Put("/members/{memberID}/addresses/{addressID}", h.address)
		r.Delete("/members/{memberID}/addresses/{addressID}", h.deleteAddress)
		r.Get("/member-dictionaries", h.dictionaries)
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
		slog.WarnContext(r.Context(), "members: ошибка заполнения полей",
			"request_id", chimiddleware.GetReqID(r.Context()), "code", "validation_failed", "errors", fields)
		httpapi.WriteProblem(w, r, httpapi.ValidationProblem(fields...))
	case errors.Is(err, ErrNotFound):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(404, "not_found", "Запись не найдена."))
	case errors.Is(err, ErrConflict):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(409, "member_conflict", "Карточка уже изменена либо адрес используется мероприятием. Обновите данные перед повторной попыткой."))
	case errors.Is(err, ErrUnavailable):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(503, "members_unavailable", "Сервис членов клуба временно недоступен."))
	default:
		auth.WriteError(w, r, err)
	}
}
func positiveID(w http.ResponseWriter, r *http.Request, key string) (int32, bool) {
	value, err := strconv.ParseInt(chi.URLParam(r, key), 10, 32)
	if err != nil || value < 1 {
		// A malformed id in the address cannot name an existing record.
		writeError(w, r, ErrNotFound)
		return 0, false
	}
	return int32(value), true
}
func queryNumber(r *http.Request, key string, fallback int64, max int64) (int64, error) {
	values, exists := r.URL.Query()[key]
	if !exists {
		return fallback, nil
	}
	if len(values) != 1 {
		return 0, invalid(key, "Параметр должен быть указан один раз.")
	}
	n, err := strconv.ParseInt(values[0], 10, 64)
	if err != nil || n < 0 || n > max {
		return 0, invalid(key, "Недопустимое значение параметра страницы.")
	}
	return n, nil
}
func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	after, err := queryNumber(r, "after", 0, 1<<31-1)
	if err != nil {
		writeError(w, r, err)
		return
	}
	limit, err := queryNumber(r, "limit", 50, 100)
	if err != nil {
		writeError(w, r, err)
		return
	}
	status, err := queryNumber(r, "membership_status_id", 0, 1<<31-1)
	if err != nil {
		writeError(w, r, err)
		return
	}
	queries := r.URL.Query()["q"]
	if len(queries) > 1 {
		writeError(w, r, invalid("q", "Укажите поисковый запрос один раз."))
		return
	}
	page, err := h.service.List(r.Context(), auth.PrincipalFrom(r), Filter{Query: r.URL.Query().Get("q"), After: int32(after), Limit: int(limit), StatusID: int32(status)})
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, page)
}
func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	var in CreateInput
	if !decode(w, r, &in) {
		return
	}
	m, err := h.service.Create(r.Context(), auth.PrincipalFrom(r), in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.Header().Set("Location", "/api/v1/members/"+strconv.FormatInt(int64(m.ID), 10))
	httpapi.WriteJSON(w, 201, m)
}
func (h *Handler) me(w http.ResponseWriter, r *http.Request) { h.read(w, r, 0) }
func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "memberID")
	if ok {
		h.read(w, r, id)
	}
}
func (h *Handler) read(w http.ResponseWriter, r *http.Request, id int32) {
	m, err := h.service.Get(r.Context(), auth.PrincipalFrom(r), id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, m)
}
func (h *Handler) patch(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "memberID")
	if !ok {
		return
	}
	var in PatchInput
	if !decode(w, r, &in) {
		return
	}
	m, err := h.service.Patch(r.Context(), auth.PrincipalFrom(r), id, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, m)
}
func (h *Handler) contact(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "memberID")
	if !ok {
		return
	}
	var contactID int32
	if r.Method == http.MethodPut {
		contactID, ok = positiveID(w, r, "contactID")
		if !ok {
			return
		}
	}
	var in ContactInput
	if !decode(w, r, &in) {
		return
	}
	m, err := h.service.SaveContact(r.Context(), auth.PrincipalFrom(r), id, contactID, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, m)
}
func (h *Handler) deleteContact(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "memberID")
	if !ok {
		return
	}
	contactID, ok := positiveID(w, r, "contactID")
	if !ok {
		return
	}
	version, err := queryNumber(r, "version", 0, 1<<63-1)
	if err != nil {
		writeError(w, r, err)
		return
	}
	m, err := h.service.DeleteContact(r.Context(), auth.PrincipalFrom(r), id, contactID, version)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, m)
}
func (h *Handler) address(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "memberID")
	if !ok {
		return
	}
	var addressID int32
	if r.Method == http.MethodPut {
		addressID, ok = positiveID(w, r, "addressID")
		if !ok {
			return
		}
	}
	var in AddressInput
	if !decode(w, r, &in) {
		return
	}
	m, err := h.service.SaveAddress(r.Context(), auth.PrincipalFrom(r), id, addressID, in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, m)
}
func (h *Handler) deleteAddress(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "memberID")
	if !ok {
		return
	}
	addressID, ok := positiveID(w, r, "addressID")
	if !ok {
		return
	}
	version, err := queryNumber(r, "version", 0, 1<<63-1)
	if err != nil {
		writeError(w, r, err)
		return
	}
	m, err := h.service.DeleteAddress(r.Context(), auth.PrincipalFrom(r), id, addressID, version)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, m)
}
func (h *Handler) history(w http.ResponseWriter, r *http.Request) {
	id, ok := positiveID(w, r, "memberID")
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
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, page)
}
func (h *Handler) dictionaries(w http.ResponseWriter, r *http.Request) {
	result, err := h.service.Dictionaries(r.Context(), auth.PrincipalFrom(r))
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, result)
}
