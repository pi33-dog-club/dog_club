package veterinary

import (
	"errors"
	"testing"
)

func TestVaccinePeriodIsCappedAtHundredYears(t *testing.T) {
	for _, test := range []struct {
		p  Period
		ok bool
	}{{Period{36500, "days"}, true}, {Period{36501, "days"}, false}, {Period{1200, "months"}, true}, {Period{1201, "months"}, false}, {Period{0, "days"}, false}} {
		if validPeriod(test.p) != test.ok {
			t.Fatalf("%+v: want %v", test.p, test.ok)
		}
	}
	in := VaccineTypeInput{Name: "", Maker: string(make([]rune, 101)), Validity: Period{12, "months"}, Revaccination: Period{12, "months"}}
	var v *ValidationError
	if err := validateVaccineType(&in); !errors.As(err, &v) || len(v.Fields) != 2 || v.Fields[0].Field != "name" || v.Fields[1].Field != "maker" {
		t.Fatalf("want name and maker errors, got %v", err)
	}
}
