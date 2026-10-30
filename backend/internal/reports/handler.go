package reports

import (
	"errors"
	"mime"
	"net/http"
	"net/url"
	"strconv"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/platform/httpapi"
	"dogclub.local/backend/internal/platform/reporting"

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
		r.Get("/reports/club-activity", h.get)
		r.Get("/reports/club-activity/export", h.export)
	})
}
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var ve *ValidationError
	switch {
	case errors.As(err, &ve):
		httpapi.WriteProblem(w, r, httpapi.ValidationProblem(httpapi.FieldError{Field: ve.Field, Code: "invalid", Message: ve.Message}))
	case errors.Is(err, ErrUnavailable):
		httpapi.WriteProblem(w, r, httpapi.NewProblem(503, "reports_unavailable", "Отчёты временно недоступны."))
	default:
		auth.WriteError(w, r, err)
	}
}
func parseQuery(r *http.Request, export bool) (reporting.Period, string, error) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return reporting.Period{}, "", invalid("query", "Некорректные параметры запроса.")
	}
	for key, entries := range values {
		if (key != "from" && key != "to" && (!export || key != "format")) || len(entries) != 1 {
			return reporting.Period{}, "", invalid("query", "Укажите только известные параметры, каждый ровно один раз.")
		}
	}
	period := reporting.Period{From: values.Get("from"), To: values.Get("to")}
	if !period.Valid() {
		return period, "", invalid("period", "Укажите обе даты периода; дата «по» не раньше даты «с».")
	}
	format := values.Get("format")
	if export && format != "pdf" && format != "csv" {
		return period, "", invalid("format", "Выберите формат файла: PDF или CSV.")
	}
	return period, format, nil
}
func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	period, _, err := parseQuery(r, false)
	if err != nil {
		writeError(w, r, err)
		return
	}
	out, err := h.service.ClubActivity(r.Context(), auth.PrincipalFrom(r), period)
	if err != nil {
		writeError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, out)
}
func (h *Handler) export(w http.ResponseWriter, r *http.Request) {
	period, format, err := parseQuery(r, true)
	if err != nil {
		writeError(w, r, err)
		return
	}
	principal := auth.PrincipalFrom(r)
	out, err := h.service.ClubActivity(r.Context(), principal, period)
	if err != nil {
		writeError(w, r, err)
		return
	}
	var data []byte
	media := "application/pdf"
	if format == "pdf" {
		data, err = renderPDF(out)
	} else {
		media = "text/csv; charset=utf-8"
		data, err = renderCSV(out)
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	if err = h.service.CheckAccess(r.Context(), principal); err != nil {
		writeError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", media)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": "club-activity-" + period.From + "-" + period.To + "." + format}))
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.WriteHeader(200)
	_, _ = w.Write(data)
}
