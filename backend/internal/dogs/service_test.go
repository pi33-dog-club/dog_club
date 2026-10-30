package dogs

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

func TestDogValidationAndMeasurements(t *testing.T) {
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	in := CreateInput{Nickname: " Лада ", DateOfBirth: "2020-01-01", Identifier: IdentifierInput{TypeID: 1, Number: " 000123 "}, StatusID: 1, BreedID: 1, CoatColorID: 1, SexID: 1, OwnerIDs: []int32{1}}
	if err := validateCreate(&in, now); err != nil || in.Identifier.Number != "000123" || in.Nickname != "Лада" {
		t.Fatal("dog validation lost normalization or leading zeroes")
	}
	for _, v := range []float64{0, -1, 0.001, 1.234, 100000, math.NaN(), math.Inf(1)} {
		in.WeightKG = &v
		if validateCreate(&in, now) == nil {
			t.Fatal("invalid measurement accepted")
		}
	}
	valid := 0.29
	in.WeightKG = &valid
	if validateCreate(&in, now) != nil {
		t.Fatal("two-decimal measurement rejected")
	}
	in.Identifier.Number = "  "
	if validateCreate(&in, now) == nil {
		t.Fatal("dog without identifier accepted")
	}
	for _, ids := range [][]int32{nil, {1, 1}, {0}, {-1}} {
		if validateOwners(ids) == nil {
			t.Fatal("invalid owners accepted")
		}
	}
}
func TestDogBirthAndMeasurementLimits(t *testing.T) {
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	in := CreateInput{Nickname: "Dog", DateOfBirth: "1900-01-01", Identifier: IdentifierInput{TypeID: 1, Number: "123"}, StatusID: 1, BreedID: 1, CoatColorID: 1, SexID: 1, OwnerIDs: []int32{1}}
	height, weight := 150.0, 200.0
	in.HeightCM, in.WeightKG = &height, &weight
	if err := validateCreate(&in, now); err != nil {
		t.Fatalf("boundary rejected: %v", err)
	}
	for _, birth := range []string{"1899-12-31", "2026-02-30", "2026-10-18"} {
		in.DateOfBirth = birth
		if validateCreate(&in, now) == nil {
			t.Fatalf("invalid birth accepted: %s", birth)
		}
	}
	in.DateOfBirth = "2020-01-01"
	height = 150.01
	if validateCreate(&in, now) == nil {
		t.Fatal("excessive height accepted")
	}
	height, weight = 150, 200.01
	if validateCreate(&in, now) == nil {
		t.Fatal("excessive weight accepted")
	}
}

func TestParentsAndPatchSemantics(t *testing.T) {
	if normalizeParent(nil, "mother") != nil {
		t.Fatal("unknown parent rejected")
	}
	id := int32(42)
	for _, p := range []*ParentInput{{}, {DogID: &id, External: &ExternalParent{Nickname: "Name"}}, {External: &ExternalParent{Issuer: "Only issuer"}}} {
		if normalizeParent(p, "mother") == nil {
			t.Fatal("ambiguous or empty parent accepted")
		}
	}
	p := &ParentInput{External: &ExternalParent{Nickname: " Арчи ", PedigreeNumber: " ABC 123 "}}
	if normalizeParent(p, "father") != nil || p.External.Nickname != "Арчи" {
		t.Fatal("external parent not normalized")
	}
	for _, body := range []string{`{"version":1,"identifier":{"type_id":1,"number":"x","unknown":1}}`, `{"version":1,"owner_ids":[1]}`} {
		var patch PatchInput
		decoder := json.NewDecoder(strings.NewReader(body))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&patch) == nil {
			t.Fatal("unknown nested or root field accepted")
		}
	}
	var patch PatchInput
	if json.Unmarshal([]byte(`{"version":1,"height_cm":null}`), &patch) != nil || !patch.HeightCM.Set || patch.WeightKG.Set || patch.HeightCM.Value != nil {
		t.Fatal("PATCH lost omission/null distinction")
	}
	if reasonValid("") == nil || reasonValid("Исправление опечатки") != nil {
		t.Fatal("title correction reason not enforced")
	}
	if likePattern(`a%_\b`) != `%a\%\_\\b%` {
		t.Fatal("SQL search wildcards were not escaped")
	}
}
