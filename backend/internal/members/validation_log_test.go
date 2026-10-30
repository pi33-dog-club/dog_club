package members

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
)

func TestValidationLogIncludesFieldAndRequestID(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	router := chi.NewRouter()
	router.Use(chimiddleware.RequestID)
	router.Post("/test", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, r, invalid("date_of_birth", "Invalid birth date"))
	})
	request := httptest.NewRequest(http.MethodPost, "/test?secret=private-query", strings.NewReader("private-body"))
	request.Header.Set("X-Request-ID", "validation-test")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != 422 {
		t.Fatalf("unexpected status: %d", response.Code)
	}
	for _, want := range []string{"date_of_birth", "Invalid birth date", "validation-test", "validation_failed"} {
		if !strings.Contains(logs.String(), want) {
			t.Fatalf("missing %q in log: %s", want, logs.String())
		}
	}
	for _, secret := range []string{"private-query", "private-body"} {
		if strings.Contains(logs.String(), secret) {
			t.Fatal("request data leaked into log")
		}
	}
}
