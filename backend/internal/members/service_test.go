package members

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestCardValidationAndDatePatches(t *testing.T) {
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	birth := "1995-03-04"
	joined := "2026-10-17"
	in := CreateInput{FullName: "  Анна  ", DateOfBirth: &birth, MembershipDate: &joined, MembershipStatusID: 1}
	if err := validateCard(&in, now); err != nil || in.FullName != "Анна" {
		t.Fatal("valid card rejected or name not normalized")
	}
	for _, value := range []string{"1899-12-31", "2026-02-30", "2026-10-18", "0000-01-01", "2026-1-01"} {
		in.DateOfBirth = &value
		var validation *ValidationError
		if !errors.As(validateCard(&in, now), &validation) {
			t.Fatal("invalid date accepted")
		}
	}
	boundary := "1900-01-01"
	in.DateOfBirth = &boundary
	if validateCard(&in, now) != nil {
		t.Fatal("earliest allowed birth date rejected")
	}
	in.DateOfBirth = &birth
	in.FullName = strings.Repeat("я", 151)
	if validateCard(&in, now) == nil {
		t.Fatal("overlong name accepted")
	}
	for _, test := range []struct {
		body  string
		set   bool
		value *string
	}{
		{`{"version":1}`, false, nil}, {`{"version":1,"date_of_birth":null}`, true, nil}, {`{"version":1,"date_of_birth":"1995-03-04"}`, true, &birth},
	} {
		var patch PatchInput
		if err := json.Unmarshal([]byte(test.body), &patch); err != nil {
			t.Fatal(err)
		}
		if patch.DateOfBirth.Set != test.set || (patch.DateOfBirth.Value == nil) != (test.value == nil) {
			t.Fatal("PATCH lost omission/null distinction")
		}
	}
}
func TestSearchTreatsWildcardsAndPhonesLiterally(t *testing.T) {
	if likePattern(`a%_\b`) != `%a\%\_\\b%` {
		t.Fatal("search wildcards not escaped")
	}
	if phoneDigits("+7 (999) 123-45-67") != "79991234567" || phoneDigits("user123@example.test") != "" {
		t.Fatal("incorrect phone normalization")
	}
}

func TestPatchRejectsUnknownAndNonNullableFields(t *testing.T) {
	for _, body := range []string{`{"version":1,"role_id":1}`, `{"version":1,"full_name":null}`, `{"version":1,"membership_status_id":null}`, `{"version":null,"full_name":"Name"}`} {
		var patch PatchInput
		if json.Unmarshal([]byte(body), &patch) == nil {
			t.Fatal("invalid PATCH field accepted")
		}
	}
}
