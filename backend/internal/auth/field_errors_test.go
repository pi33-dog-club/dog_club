package auth

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInviteErrorsNameFormFields(t *testing.T) {
	_, err := normalizeInvite(InviteInput{Login: "Борис", Email: "Борис <b@x.ru>", Role: "boss"})
	var input *InputError
	if !errors.As(err, &input) || !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want field errors, got %v", err)
	}
	var got []string
	for _, f := range input.Fields {
		got = append(got, f.Field)
	}
	if strings.Join(got, ",") != "login,email,role" {
		t.Fatalf("fields: %v", got)
	}
	w := httptest.NewRecorder()
	writeAuthError(w, httptest.NewRequest("POST", "/api/v1/invitations", nil), err)
	if w.Code != 422 || !strings.Contains(w.Body.String(), `"field":"login"`) || strings.Contains(w.Body.String(), "байт") {
		t.Fatalf("response %d %s", w.Code, w.Body.String())
	}
}
