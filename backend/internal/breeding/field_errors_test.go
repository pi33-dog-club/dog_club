package breeding

import (
	"errors"
	"testing"
)

func TestRequestPairErrorsNameDogFields(t *testing.T) {
	for _, test := range []struct {
		in    RequestInput
		field string
	}{
		{RequestInput{MaleID: 2, PlannedDate: "2026-10-01"}, "female_dog_id"},
		{RequestInput{FemaleID: 1, PlannedDate: "2026-10-01"}, "male_dog_id"},
		{RequestInput{FemaleID: 1, MaleID: 1, PlannedDate: "2026-10-01"}, "male_dog_id"},
	} {
		var v *ValidationError
		if err := validateRequest(&test.in); !errors.As(err, &v) || v.Fields[0].Field != test.field {
			t.Fatalf("%+v: want %s, got %v", test.in, test.field, err)
		}
	}
}
