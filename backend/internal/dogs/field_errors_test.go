package dogs

import (
	"context"
	"errors"
	"testing"

	"dogclub.local/backend/internal/auth"
)

// Number and issuer of a pedigree go together, as the client form requires.
func TestPedigreeNumberAndIssuerTogether(t *testing.T) {
	for _, test := range []struct {
		in    PedigreeInput
		field string
	}{
		{PedigreeInput{Version: 1, Number: "РКФ 123"}, "issuer"},
		{PedigreeInput{Version: 1, Issuer: "РКФ"}, "number"},
	} {
		_, err := (&Service{}).SetPedigree(context.Background(), auth.Principal{}, 1, test.in)
		var v *ValidationError
		if !errors.As(err, &v) || len(v.Fields) != 1 || v.Fields[0].Field != test.field {
			t.Fatalf("%+v: want error at %s, got %v", test.in, test.field, err)
		}
	}
}
