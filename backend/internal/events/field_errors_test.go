package events

import (
	"errors"
	"slices"
	"testing"
)

// fieldsOf returns the field names of a validation error in order.
func fieldsOf(t *testing.T, err error) []string {
	t.Helper()
	var v *ValidationError
	if !errors.As(err, &v) {
		t.Fatalf("want a validation error, got %v", err)
	}
	var out []string
	for _, f := range v.Fields {
		out = append(out, f.Field)
	}
	return out
}

// The client shows each message under the form field with the same name.
func TestEventErrorsNameFormFields(t *testing.T) {
	venue := VenueInput{Street: string(make([]rune, 101))}
	if got := fieldsOf(t, validateVenue(&venue)); !slices.Equal(got, []string{"name", "locality", "street"}) {
		t.Fatalf("venue fields: %v", got)
	}
	event := EventInput{Audience: "people", UsesClasses: true, Timezone: "Europe/Moscow"}
	got := fieldsOf(t, validateEvent(&event))
	for _, want := range []string{"name", "type_id", "venue_id", "uses_classes", "starts_at", "ends_at"} {
		if !slices.Contains(got, want) {
			t.Fatalf("event fields %v miss %s", got, want)
		}
	}
	early := EventInput{Name: "Выставка", TypeID: 1, VenueID: 1, Audience: "dogs", Timezone: "Europe/Moscow", StartsAt: at("2026-10-02T10:00:00Z"), EndsAt: at("2026-10-01T10:00:00Z")}
	if got := fieldsOf(t, validateEvent(&early)); !slices.Equal(got, []string{"ends_at"}) {
		t.Fatalf("period fields: %v", got)
	}
	class := ClassInput{Name: "Юниоры", MinAgeMonths: ptr[int32](12), MaxAgeMonths: ptr[int32](6), Requirements: "Диплом"}
	if got := fieldsOf(t, validateClass(&class)); !slices.Equal(got, []string{"max_age_months", "requires_expert"}) {
		t.Fatalf("class fields: %v", got)
	}
	result := ResultInput{Place: ptr[int32](0)}
	if got := fieldsOf(t, validateResult(&result)); !slices.Equal(got, []string{"place"}) {
		t.Fatalf("result fields: %v", got)
	}
}
