package members

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"dogclub.local/backend/internal/auth"
)

func TestAddressErrorsNameFormFields(t *testing.T) {
	_, err := (&Service{}).SaveAddress(context.Background(), auth.Principal{}, 1, 0, AddressInput{Version: 1, Street: strings.Repeat("у", 101), ApartmentNumber: strings.Repeat("1", 21)})
	var v *ValidationError
	if !errors.As(err, &v) {
		t.Fatalf("want validation error, got %v", err)
	}
	var got []string
	for _, f := range v.Fields {
		got = append(got, f.Field)
	}
	if !slices.Equal(got, []string{"type_id", "locality", "street", "apartment_number"}) {
		t.Fatalf("address fields: %v", got)
	}
}
