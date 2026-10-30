package breeding

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/dogs"
	"dogclub.local/backend/internal/members"
	"dogclub.local/backend/internal/platform/notify"
	"dogclub.local/backend/internal/veterinary"

	"github.com/jackc/pgx/v5"
)

type Service struct {
	notifications notify.Sink
	access        *auth.Service
	dogs          *dogs.Service
	veterinary    *veterinary.Service
	now           func() time.Time
}

func NewService(a *auth.Service, d *dogs.Service, v *veterinary.Service) *Service {
	return &Service{access: a, dogs: d, veterinary: v, now: time.Now}
}

var readRoles = []string{"staff", "expert", "leader", "owner"}

func textOK(v string, max int) bool {
	return utf8.ValidString(v) && utf8.RuneCountInString(v) <= max && !strings.ContainsFunc(v, unicode.IsControl)
}
func validDate(v string) bool {
	d, err := time.Parse(time.DateOnly, v)
	return err == nil && d.Year() > 0
}
func correction(in *Correction) error {
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Version < 1 {
		return invalid("version", "Обновите страницу и повторите действие.")
	}
	if in.Reason == "" || !textOK(in.Reason, 500) {
		return invalid("reason", "Укажите причину, не больше 500 символов.")
	}
	return nil
}
func validateRequest(in *RequestInput) error {
	in.Comment = strings.TrimSpace(in.Comment)
	var fields []FieldError
	if in.FemaleID < 1 {
		fields = append(fields, FieldError{"female_dog_id", "Выберите суку."})
	}
	if in.MaleID < 1 {
		fields = append(fields, FieldError{"male_dog_id", "Выберите кобеля."})
	} else if in.FemaleID == in.MaleID {
		fields = append(fields, FieldError{"male_dog_id", "Выберите двух разных собак."})
	}
	if len(fields) > 0 {
		return &ValidationError{fields}
	}
	if !validDate(in.PlannedDate) {
		return invalid("planned_date", "Укажите существующую дату.")
	}
	if in.ExpectedBirthDate != nil && (!validDate(*in.ExpectedBirthDate) || *in.ExpectedBirthDate <= in.PlannedDate) {
		return invalid("expected_birth_date", "Ожидаемая дата рождения должна быть позже вязки.")
	}
	if !textOK(in.Comment, 2000) {
		return invalid("comment", "Комментарий — не больше 2000 символов.")
	}
	return nil
}
func domainError(err error) error {
	if err == nil {
		return nil
	}
	var d *dogs.ValidationError
	var v *veterinary.ValidationError
	if errors.As(err, &d) {
		fields := []FieldError{}
		for _, f := range d.Fields {
			fields = append(fields, FieldError{f.Field, f.Message})
		}
		return &ValidationError{fields}
	}
	if errors.As(err, &v) {
		fields := []FieldError{}
		for _, f := range v.Fields {
			fields = append(fields, FieldError{f.Field, f.Message})
		}
		return &ValidationError{fields}
	}
	if errors.Is(err, dogs.ErrNotFound) || errors.Is(err, veterinary.ErrNotFound) {
		return ErrNotFound
	}
	if errors.Is(err, dogs.ErrConflict) || errors.Is(err, veterinary.ErrConflict) {
		return ErrConflict
	}
	if errors.Is(err, dogs.ErrUnavailable) || errors.Is(err, veterinary.ErrUnavailable) || errors.Is(err, members.ErrUnavailable) {
		return ErrUnavailable
	}
	return err
}
func with[T any](ctx context.Context, s *Service, p auth.Principal, roles []string, fn func(context.Context, *repository, auth.Principal) (T, error)) (T, error) {
	var out T
	err := s.access.WithAccess(ctx, p, roles, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		ctx = notify.WithSink(ctx, s.notifications)
		if current.Profile.Role == "owner" {
			if _, err := s.dogs.BreedingOwnerDogs(ctx, tx, current); err != nil {
				return domainError(err)
			}
		}
		var err error
		out, err = fn(ctx, &repository{tx}, current)
		return domainError(err)
	})
	return out, err
}
func (s *Service) checkOwner(ctx context.Context, q *repository, p auth.Principal, related ...int32) error {
	if p.Profile.Role != "owner" {
		return nil
	}
	ids, err := s.dogs.BreedingOwnerDogs(ctx, q.tx, p)
	if err != nil {
		return err
	}
	for _, id := range related {
		if slices.Contains(ids, id) {
			return nil
		}
	}
	return ErrNotFound
}
func (s *Service) load(ctx context.Context, q *repository, p auth.Principal, entity string, id int64) (any, error) {
	var female, male int32
	var out any
	var err error
	var puppies []int32
	switch entity {
	case "request":
		var v Request
		v, err = q.request(ctx, id)
		female, male = v.FemaleID, v.MaleID
		if p.Profile.Role == "owner" {
			v.Assessment = nil
		}
		out = v
	case "breeding":
		var v Mating
		v, err = q.mating(ctx, id)
		female, male = v.FemaleID, v.MaleID
		if p.Profile.Role == "owner" {
			v.Assessment = nil
		}
		out = v
	case "litter":
		var v Litter
		v, err = q.litter(ctx, id)
		female, male = v.FemaleID, v.MaleID
		puppies = v.DogIDs
		out = v
	default:
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, s.checkOwner(ctx, q, p, append([]int32{female, male}, puppies...)...)
}
func (s *Service) Get(ctx context.Context, p auth.Principal, entity string, id int64) (any, error) {
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, p auth.Principal) (any, error) {
		return s.load(ctx, q, p, entity, id)
	})
}
func (s *Service) List(ctx context.Context, p auth.Principal, entity string, f Filter) (Page[any], error) {
	if f.Limit < 1 || f.Limit > 100 || f.After < 0 || f.DogID < 0 {
		return Page[any]{}, invalid("query", "Проверьте параметры страницы.")
	}
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, p auth.Principal) (Page[any], error) {
		out := Page[any]{Records: []any{}}
		owned := []int32{}
		if p.Profile.Role == "owner" {
			var err error
			owned, err = s.dogs.BreedingOwnerDogs(ctx, q.tx, p)
			if err != nil {
				return out, err
			}
		}
		ids, err := q.ids(ctx, entity, f, owned, p.Profile.Role != "owner")
		if err != nil {
			return out, err
		}
		if len(ids) > f.Limit {
			ids = ids[:f.Limit]
			id := ids[len(ids)-1]
			out.NextAfter = &id
		}
		for _, id := range ids {
			v, err := s.load(ctx, q, p, entity, id)
			if err != nil {
				return out, err
			}
			out.Records = append(out.Records, v)
		}
		return out, nil
	})
}
func (s *Service) Patients(ctx context.Context, p auth.Principal, f dogs.Filter) (dogs.Page, error) {
	return with(ctx, s, p, []string{"staff", "expert", "leader"}, func(ctx context.Context, q *repository, p auth.Principal) (dogs.Page, error) {
		return s.dogs.ListForBreeding(ctx, q.tx, p, f)
	})
}
func (s *Service) MateCandidates(ctx context.Context, p auth.Principal, dogID int32) (MateCandidates, error) {
	return with(ctx, s, p, []string{"staff", "expert", "leader"}, func(ctx context.Context, q *repository, p auth.Principal) (MateCandidates, error) {
		asOf := s.now().UTC().Format(time.DateOnly)
		out := MateCandidates{DogID: dogID, AsOf: asOf, Candidates: []dogs.Summary{}}
		target, err := s.dogs.ReadForBreeding(ctx, q.tx, p, dogID)
		if err != nil {
			return out, err
		}
		if target.Inactive() {
			return out, invalid("dog_id", fmt.Sprintf("Собака имеет статус «%s»: пара не подбирается.", target.Status.Name))
		}
		found, truncated, err := s.dogs.ListMateCandidates(ctx, q.tx, p, target.Summary, asOf, MateCandidateScan)
		if err != nil {
			return out, err
		}
		out.Truncated = truncated
		for _, c := range found {
			ok, err := s.suitableMate(ctx, q, p, target, c.ID, asOf)
			if err != nil {
				return out, err
			}
			if ok {
				out.Candidates = append(out.Candidates, c)
			}
		}
		return out, nil
	})
}

// suitableMate applies the remaining fn_suggest_mates filters: no close kinship,
// no confirmed hereditary diagnosis and, for a bitch, readiness for a new litter.
func (s *Service) suitableMate(ctx context.Context, q *repository, p auth.Principal, target dogs.BreedingAnimal, id int32, asOf string) (bool, error) {
	candidate, err := s.dogs.ReadForBreeding(ctx, q.tx, p, id)
	if err != nil {
		return false, err
	}
	female, male := target, candidate
	if candidate.Sex.Name == "Сука" {
		female, male = candidate, target
	}
	if kinship(female, male) != "" {
		return false, nil
	}
	health, err := s.veterinary.CheckForBreeding(ctx, q.tx, p, id, asOf)
	if err != nil {
		return false, err
	}
	for _, finding := range health.Findings {
		if finding.IsHereditary != nil && *finding.IsHereditary {
			return false, nil
		}
	}
	if candidate.Sex.Name != "Сука" {
		return true, nil
	}
	unresolved, reserved, err := q.occupied(ctx, id, 0, 0)
	if err != nil || unresolved || reserved {
		return false, err
	}
	birth, err := q.lastBirth(ctx, id, 0)
	if err != nil || birth == nil {
		return err == nil, err
	}
	// Ready once the litter interval since the previous birth has fully passed.
	earliest, err := earliestBirth(birth)
	if err != nil {
		return false, err
	}
	return *earliest <= asOf, nil
}
func (s *Service) CreateRequest(ctx context.Context, p auth.Principal, in RequestInput) (Request, error) {
	if err := validateRequest(&in); err != nil {
		return Request{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, p auth.Principal) (Request, error) {
		if _, err := s.dogs.ReadForBreeding(ctx, q.tx, p, in.FemaleID); err != nil {
			return Request{}, err
		}
		if _, err := s.dogs.ReadForBreeding(ctx, q.tx, p, in.MaleID); err != nil {
			return Request{}, err
		}
		id, err := q.saveRequest(ctx, Request{FemaleID: in.FemaleID, MaleID: in.MaleID, PlannedDate: in.PlannedDate, ExpectedBirthDate: in.ExpectedBirthDate, Comment: in.Comment})
		if err != nil {
			return Request{}, err
		}
		out, err := q.request(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, p, "request", id, "created", "", nil, out)
	})
}
func (s *Service) UpdateRequest(ctx context.Context, p auth.Principal, id int64, in RequestUpdate) (Request, error) {
	if err := validateRequest(&in.RequestInput); err != nil {
		return Request{}, err
	}
	if err := correction(&Correction{in.Version, in.Reason}); err != nil {
		return Request{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, p auth.Principal) (Request, error) {
		before, err := q.request(ctx, id)
		if err != nil {
			return before, err
		}
		if before.Version != in.Version {
			return before, ErrConflict
		}
		exists, err := q.hasMating(ctx, id)
		if err != nil {
			return before, err
		}
		if exists || before.Status == "cancelled" {
			return before, ErrConflict
		}
		for _, dog := range []int32{in.FemaleID, in.MaleID} {
			if _, err := s.dogs.ReadForBreeding(ctx, q.tx, p, dog); err != nil {
				return Request{}, err
			}
		}
		if err = q.bump(ctx, "request", id, in.Version); err != nil {
			return Request{}, err
		}
		_, err = q.saveRequest(ctx, Request{ID: id, FemaleID: in.FemaleID, MaleID: in.MaleID, PlannedDate: in.PlannedDate, ExpectedBirthDate: in.ExpectedBirthDate, Status: "pending", Comment: in.Comment})
		if err != nil {
			return Request{}, err
		}
		out, err := q.request(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, p, "request", id, "corrected", strings.TrimSpace(in.Reason), before, out)
	})
}
func (s *Service) Cancel(ctx context.Context, p auth.Principal, id int64, in Correction) (Request, error) {
	if err := correction(&in); err != nil {
		return Request{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, p auth.Principal) (Request, error) {
		before, err := q.request(ctx, id)
		if err != nil {
			return before, err
		}
		if before.Version != in.Version {
			return before, ErrConflict
		}
		exists, err := q.hasMating(ctx, id)
		if err != nil {
			return before, err
		}
		if exists || before.Status == "cancelled" {
			return before, ErrConflict
		}
		if err = q.bump(ctx, "request", id, in.Version); err != nil {
			return Request{}, err
		}
		v := before
		v.Status = "cancelled"
		if _, err = q.saveRequest(ctx, v); err != nil {
			return Request{}, err
		}
		out, err := q.request(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, p, "request", id, "cancelled", in.Reason, before, out)
	})
}
func earliestBirth(last *string) (*string, error) {
	if last == nil {
		return nil, nil
	}
	date, err := time.Parse(time.DateOnly, *last)
	if err != nil {
		return nil, ErrUnavailable
	}
	next := date.AddDate(0, 0, LitterIntervalDays)
	if next.Year() > 9999 {
		return nil, invalid("date", "Дата выходит за поддерживаемый диапазон.")
	}
	out := next.Format(time.DateOnly)
	return &out, nil
}
func commonAncestors(f, m dogs.BreedingAnimal) []int32 {
	ids := map[int32]bool{f.ID: true}
	for _, id := range f.AncestorIDs {
		ids[id] = true
	}
	common := []int32{}
	for _, id := range append([]int32{m.ID}, m.AncestorIDs...) {
		if ids[id] {
			common = append(common, id)
		}
	}
	slices.Sort(common)
	return slices.Compact(common)
}

// kinship applies lab 3 fn_check_breeding_relatedness within three generations:
// parent and child, a shared parent, then any shared ancestor. Deeper common
// ancestors stay a warning for the expert.
func kinship(f, m dogs.BreedingAnimal) string {
	if f.Generations[m.ID] == 1 || m.Generations[f.ID] == 1 {
		return "parent_child"
	}
	shared := ""
	for id, fg := range f.Generations {
		mg, ok := m.Generations[id]
		if !ok || fg > dogs.PedigreeGenerations || mg > dogs.PedigreeGenerations || (fg == 0 && mg == 0) {
			continue
		}
		if fg == 1 && mg == 1 {
			return "shared_parent"
		}
		shared = "common_ancestor_3_generations"
	}
	return shared
}
func (s *Service) assess(ctx context.Context, q *repository, p auth.Principal, r Request, asOf string, breedingID int64) (Assessment, error) {
	out := Assessment{AsOf: asOf, CommonAncestorIDs: []int32{}, BlockingReasons: []string{}, Warnings: []string{}, IntervalDays: LitterIntervalDays}
	var err error
	out.Female, err = s.dogs.ReadForBreeding(ctx, q.tx, p, r.FemaleID)
	if err != nil {
		return out, err
	}
	out.Male, err = s.dogs.ReadForBreeding(ctx, q.tx, p, r.MaleID)
	if err != nil {
		return out, err
	}
	if r.FemaleID == r.MaleID {
		out.BlockingReasons = append(out.BlockingReasons, "same_dog")
	}
	// Lab 3 fn_dog_active_check_breeding: each partner is checked separately.
	if out.Female.Inactive() {
		out.BlockingReasons = append(out.BlockingReasons, "female_inactive")
	}
	if out.Male.Inactive() {
		out.BlockingReasons = append(out.BlockingReasons, "male_inactive")
	}
	if out.Female.Sex.Name != "Сука" || out.Male.Sex.Name != "Кобель" {
		out.BlockingReasons = append(out.BlockingReasons, "pair_sex")
	}
	if out.Female.Breed.ID != out.Male.Breed.ID {
		out.BlockingReasons = append(out.BlockingReasons, "different_breeds")
	}
	if out.Female.DateOfBirth >= asOf || out.Male.DateOfBirth >= asOf {
		out.BlockingReasons = append(out.BlockingReasons, "pair_birth_dates")
	}
	if strings.TrimSpace(out.Female.Identifier.Number) == "" || strings.TrimSpace(out.Male.Identifier.Number) == "" {
		out.BlockingReasons = append(out.BlockingReasons, "identifier_missing")
	}
	out.FemaleHealth, err = s.veterinary.CheckForBreeding(ctx, q.tx, p, r.FemaleID, asOf)
	if err != nil {
		return out, err
	}
	out.MaleHealth, err = s.veterinary.CheckForBreeding(ctx, q.tx, p, r.MaleID, asOf)
	if err != nil {
		return out, err
	}
	if out.FemaleHealth.Admission.Decision != "allowed" {
		out.BlockingReasons = append(out.BlockingReasons, "female_medical_clearance")
	}
	if out.MaleHealth.Admission.Decision != "allowed" {
		out.BlockingReasons = append(out.BlockingReasons, "male_medical_clearance")
	}
	out.CommonAncestorIDs = commonAncestors(out.Female, out.Male)
	if r.FemaleID != r.MaleID {
		if reason := kinship(out.Female, out.Male); reason != "" {
			out.BlockingReasons = append(out.BlockingReasons, reason)
		}
	}
	if len(out.CommonAncestorIDs) > 0 {
		out.Warnings = append(out.Warnings, "known_relationship")
	}
	if out.Female.AncestryIncomplete || out.Male.AncestryIncomplete {
		out.Warnings = append(out.Warnings, "ancestry_incomplete")
	}
	if len(out.FemaleHealth.Findings) > 0 || len(out.MaleHealth.Findings) > 0 {
		out.Warnings = append(out.Warnings, "hereditary_findings_require_expert")
	}
	birth, err := q.lastBirth(ctx, r.FemaleID, breedingID)
	if err != nil {
		return out, err
	}
	out.EarliestBirthDate, err = earliestBirth(birth)
	if err != nil {
		return out, err
	}
	if birth == nil {
		out.Warnings = append(out.Warnings, "earlier_litters_not_recorded")
	} else if r.ExpectedBirthDate == nil {
		out.BlockingReasons = append(out.BlockingReasons, "expected_birth_date_required")
	} else if *r.ExpectedBirthDate < *out.EarliestBirthDate {
		out.BlockingReasons = append(out.BlockingReasons, "litter_interval")
	}
	if r.ExpectedBirthDate != nil && *r.ExpectedBirthDate <= asOf {
		out.BlockingReasons = append(out.BlockingReasons, "expected_birth_before_mating")
	}
	unresolved, reserved, err := q.occupied(ctx, r.FemaleID, r.ID, breedingID)
	if err != nil {
		return out, err
	}
	if unresolved {
		out.BlockingReasons = append(out.BlockingReasons, "previous_outcome_unknown")
	}
	if reserved {
		out.BlockingReasons = append(out.BlockingReasons, "another_approved_request")
	}
	return out, nil
}
func (s *Service) Check(ctx context.Context, p auth.Principal, id int64) (Assessment, error) {
	return with(ctx, s, p, []string{"staff", "expert", "leader"}, func(ctx context.Context, q *repository, p auth.Principal) (Assessment, error) {
		r, err := q.request(ctx, id)
		if err != nil {
			return Assessment{}, err
		}
		return s.assess(ctx, q, p, r, r.PlannedDate, 0)
	})
}
func (s *Service) Decide(ctx context.Context, p auth.Principal, id int64, in DecisionInput) (Request, error) {
	if err := correction(&in.Correction); err != nil {
		return Request{}, err
	}
	if in.Decision != "approved" && in.Decision != "rejected" {
		return Request{}, invalid("decision", "Выберите решение: одобрить или отклонить заявку.")
	}
	return with(ctx, s, p, []string{"expert"}, func(ctx context.Context, q *repository, p auth.Principal) (Request, error) {
		before, err := q.request(ctx, id)
		if err != nil {
			return before, err
		}
		if before.Version != in.Version {
			return before, ErrConflict
		}
		if before.Status != "pending" {
			return before, ErrConflict
		}
		r := before
		if in.ExpectedBirthDate != nil {
			if !validDate(*in.ExpectedBirthDate) || *in.ExpectedBirthDate <= r.PlannedDate {
				return r, invalid("expected_birth_date", "Ожидаемая дата должна быть позже вязки.")
			}
			r.ExpectedBirthDate = in.ExpectedBirthDate
		}
		a, err := s.assess(ctx, q, p, r, r.PlannedDate, 0)
		if err != nil {
			return r, err
		}
		if in.Decision == "approved" && len(a.BlockingReasons) > 0 {
			return r, invalid("checks", "Не устранены блокирующие причины. Выполните проверку пары.")
		}
		if err = q.bump(ctx, "request", id, in.Version); err != nil {
			return Request{}, err
		}
		if err = q.decide(ctx, p, r, in, a); err != nil {
			return Request{}, err
		}
		r.Status = in.Decision
		r.Assessment = &a
		if _, err = q.saveRequest(ctx, r); err != nil {
			return Request{}, err
		}
		out, err := q.request(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, p, "request", id, in.Decision, in.Reason, before, out)
	})
}
func (s *Service) Decisions(ctx context.Context, p auth.Principal, id int64, f Filter) (Page[Decision], error) {
	if err := pageValid(f); err != nil {
		return Page[Decision]{}, err
	}
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, p auth.Principal) (Page[Decision], error) {
		if _, err := s.load(ctx, q, p, "request", id); err != nil {
			return Page[Decision]{}, err
		}
		out, err := q.decisions(ctx, id, f)
		if p.Profile.Role == "owner" {
			for i := range out.Records {
				out.Records[i].Assessment = nil
			}
		}
		return out, err
	})
}
func (s *Service) Perform(ctx context.Context, p auth.Principal, id int64, in MatingInput) (Mating, error) {
	if err := correction(&in.Correction); err != nil {
		return Mating{}, err
	}
	if !validDate(in.Date) || in.Date > s.now().UTC().Format(time.DateOnly) {
		return Mating{}, invalid("date", "Фактическая дата не может быть в будущем.")
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, p auth.Principal) (Mating, error) {
		r, err := q.request(ctx, id)
		if err != nil {
			return Mating{}, err
		}
		if r.Version != in.Version {
			return Mating{}, ErrConflict
		}
		if r.Status != "approved" {
			return Mating{}, ErrConflict
		}
		if in.Date != r.PlannedDate {
			return Mating{}, invalid("date", "Измените дату заявки и получите повторное одобрение эксперта.")
		}
		exists, err := q.hasMating(ctx, id)
		if err != nil {
			return Mating{}, err
		}
		if exists {
			return Mating{}, ErrConflict
		}
		a, err := s.assess(ctx, q, p, r, in.Date, 0)
		if err != nil {
			return Mating{}, err
		}
		if len(a.BlockingReasons) > 0 {
			return Mating{}, invalid("checks", "Проверка перед проведением не пройдена.")
		}
		if err = q.bump(ctx, "request", id, in.Version); err != nil {
			return Mating{}, err
		}
		mid, err := q.createMating(ctx, r, in.Date, a)
		if err != nil {
			return Mating{}, err
		}
		after, err := q.request(ctx, id)
		if err != nil {
			return Mating{}, err
		}
		if err = q.record(ctx, p, "request", id, "performed", in.Reason, r, after); err != nil {
			return Mating{}, err
		}
		out, err := q.mating(ctx, mid)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, p, "breeding", mid, "performed", in.Reason, nil, out)
	})
}
func (s *Service) UpdateMating(ctx context.Context, p auth.Principal, id int64, in MatingUpdate) (Mating, error) {
	if err := correction(&in.Correction); err != nil {
		return Mating{}, err
	}
	if !validDate(in.Date) || in.Date > s.now().UTC().Format(time.DateOnly) {
		return Mating{}, invalid("date", "Укажите фактическую дату не позднее сегодня.")
	}
	if in.Outcome != "unknown" && in.Outcome != "no_litter" && in.Outcome != "litter" {
		return Mating{}, invalid("outcome", "Выберите исход вязки: неизвестен, без помёта или помёт.")
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, p auth.Principal) (Mating, error) {
		before, err := q.mating(ctx, id)
		if err != nil {
			return before, err
		}
		if before.Version != in.Version {
			return before, ErrConflict
		}
		if before.Status.Name != "Проведена" {
			return before, ErrConflict
		}
		birth, err := q.birthForMating(ctx, id)
		if err != nil {
			return before, err
		}
		if (birth != nil) != (in.Outcome == "litter") {
			return before, invalid("outcome", "Исход должен соответствовать зарегистрированному помёту.")
		}
		if birth != nil && in.Date >= *birth {
			return before, invalid("date", "Вязка должна предшествовать рождению помёта.")
		}
		if before.Date == nil || in.Date != *before.Date {
			if before.RequestID == nil {
				return before, invalid("date", "У старой записи нет согласованной заявки для проверки новой даты.")
			}
			r, err := q.request(ctx, *before.RequestID)
			if err != nil {
				return before, err
			}
			if in.Date != r.PlannedDate {
				return before, invalid("date", "Дата должна соответствовать одобренной заявке.")
			}
			a, err := s.assess(ctx, q, p, r, in.Date, id)
			if err != nil {
				return before, err
			}
			if len(a.BlockingReasons) > 0 {
				return before, invalid("checks", "Проверка новой даты не пройдена.")
			}
		}
		if err = q.bump(ctx, "breeding", id, in.Version); err != nil {
			return before, err
		}
		if err = q.updateMating(ctx, id, in.Date, in.Outcome); err != nil {
			return before, err
		}
		out, err := q.mating(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, p, "breeding", id, "corrected", in.Reason, before, out)
	})
}
func (s *Service) validateLitter(ctx context.Context, q *repository, p auth.Principal, m Mating, date string, count int32) error {
	if !validDate(date) || date > s.now().UTC().Format(time.DateOnly) || m.Date == nil || date <= *m.Date {
		return invalid("date_of_birth", "Рождение должно быть после вязки и не позднее сегодня.")
	}
	if count < 1 {
		return invalid("total_puppies", "Укажите положительное количество щенков.")
	}
	for _, id := range []int32{m.FemaleID, m.MaleID} {
		d, err := s.dogs.ReadForBreeding(ctx, q.tx, p, id)
		if err != nil {
			return err
		}
		if d.DateOfBirth >= date {
			return invalid("date_of_birth", "Родители должны быть старше потомства.")
		}
	}
	return nil
}
func (s *Service) CreateLitter(ctx context.Context, p auth.Principal, in LitterInput) (Litter, error) {
	if in.BreedingID < 1 || in.BreedingID > 1<<31-1 {
		return Litter{}, invalid("breeding_id", "Выберите вязку.")
	}
	if err := correction(&in.Correction); err != nil {
		return Litter{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, p auth.Principal) (Litter, error) {
		m, err := q.mating(ctx, in.BreedingID)
		if err != nil {
			return Litter{}, err
		}
		if m.Version != in.Version {
			return Litter{}, ErrConflict
		}
		if m.Status.Name != "Проведена" {
			return Litter{}, ErrConflict
		}
		if err = s.validateLitter(ctx, q, p, m, in.DateOfBirth, in.TotalPuppies); err != nil {
			return Litter{}, err
		}
		if err = q.bump(ctx, "breeding", m.ID, in.Version); err != nil {
			return Litter{}, err
		}
		id, err := q.createLitter(ctx, m.ID, in.DateOfBirth, in.TotalPuppies)
		if err != nil {
			return Litter{}, err
		}
		next, err := q.mating(ctx, m.ID)
		if err != nil {
			return Litter{}, err
		}
		if err = q.record(ctx, p, "breeding", m.ID, "litter_recorded", in.Reason, m, next); err != nil {
			return Litter{}, err
		}
		out, err := q.litter(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, p, "litter", id, "created", in.Reason, nil, out)
	})
}
func (s *Service) UpdateLitter(ctx context.Context, p auth.Principal, id int64, in LitterUpdate) (Litter, error) {
	if err := correction(&in.Correction); err != nil {
		return Litter{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, p auth.Principal) (Litter, error) {
		before, err := q.litter(ctx, id)
		if err != nil {
			return before, err
		}
		if before.Version != in.Version {
			return before, ErrConflict
		}
		m, err := q.mating(ctx, before.BreedingID)
		if err != nil {
			return before, err
		}
		if err = s.validateLitter(ctx, q, p, m, in.DateOfBirth, in.TotalPuppies); err != nil {
			return before, err
		}
		if int64(in.TotalPuppies) < int64(len(before.DogIDs)) {
			return before, invalid("total_puppies", "Количество меньше числа зарегистрированных щенков.")
		}
		if in.DateOfBirth != before.DateOfBirth && len(before.DogIDs) > 0 {
			return before, invalid("date_of_birth", "Сначала устраните связи с карточками щенков, чтобы исправление не создало противоречие.")
		}
		if err = q.bump(ctx, "litter", id, in.Version); err != nil {
			return before, err
		}
		if err = q.updateLitter(ctx, id, in.DateOfBirth, in.TotalPuppies); err != nil {
			return before, err
		}
		out, err := q.litter(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, p, "litter", id, "corrected", in.Reason, before, out)
	})
}
func (s *Service) puppy(ctx context.Context, p auth.Principal, id int64, in Correction, fn func(context.Context, *repository, auth.Principal, Litter) (int32, error), action string) (Litter, error) {
	if err := correction(&in); err != nil {
		return Litter{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, p auth.Principal) (Litter, error) {
		before, err := q.litter(ctx, id)
		if err != nil {
			return before, err
		}
		if before.Version != in.Version {
			return before, ErrConflict
		}
		if action != "puppy_unlinked" && len(before.DogIDs) >= int(before.TotalPuppies) {
			return before, invalid("total_puppies", "Все щенки помёта уже зарегистрированы.")
		}
		if err = q.bump(ctx, "litter", id, in.Version); err != nil {
			return before, err
		}
		dogID, err := fn(ctx, q, p, before)
		if err != nil {
			return before, err
		}
		if err = q.link(ctx, id, dogID, action == "puppy_unlinked"); err != nil {
			return before, err
		}
		out, err := q.litter(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, p, "litter", id, action, in.Reason, before, out)
	})
}
func (s *Service) RegisterPuppy(ctx context.Context, p auth.Principal, id int64, in PuppyInput) (Litter, error) {
	return s.puppy(ctx, p, id, in.Correction, func(ctx context.Context, q *repository, p auth.Principal, l Litter) (int32, error) {
		mother, err := s.dogs.ReadForBreeding(ctx, q.tx, p, l.FemaleID)
		if err != nil {
			return 0, err
		}
		dog, err := s.dogs.RegisterForBreeding(ctx, q.tx, p, dogs.CreateInput{Nickname: in.Nickname, DateOfBirth: l.DateOfBirth, Identifier: in.Identifier, StatusID: in.StatusID, BreedID: mother.Breed.ID, CoatColorID: in.CoatColorID, SexID: in.SexID, OwnerIDs: in.OwnerIDs}, l.FemaleID, l.MaleID)
		return dog.ID, err
	}, "puppy_registered")
}
func (s *Service) LinkPuppy(ctx context.Context, p auth.Principal, id int64, in LinkInput) (Litter, error) {
	if in.DogID < 1 || in.DogVersion < 1 {
		return Litter{}, invalid("dog_id", "Укажите собаку и текущую версию карточки.")
	}
	return s.puppy(ctx, p, id, in.Correction, func(ctx context.Context, q *repository, p auth.Principal, l Litter) (int32, error) {
		mother, err := s.dogs.ReadForBreeding(ctx, q.tx, p, l.FemaleID)
		if err != nil {
			return 0, err
		}
		dog, err := s.dogs.PrepareForLitter(ctx, q.tx, p, in.DogID, in.DogVersion, l.DateOfBirth, mother.Breed.ID, l.FemaleID, l.MaleID)
		return dog.ID, err
	}, "puppy_linked")
}
func (s *Service) UnlinkPuppy(ctx context.Context, p auth.Principal, id int64, dogID int32, in Correction) (Litter, error) {
	return s.puppy(ctx, p, id, in, func(context.Context, *repository, auth.Principal, Litter) (int32, error) { return dogID, nil }, "puppy_unlinked")
}
func pageValid(f Filter) error {
	if f.After < 0 || f.Limit < 1 || f.Limit > 100 {
		return invalid("query", "Проверьте параметры страницы.")
	}
	return nil
}
func (s *Service) History(ctx context.Context, p auth.Principal, entity string, id int64, f Filter) (Page[Change], error) {
	if err := pageValid(f); err != nil {
		return Page[Change]{}, err
	}
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, p auth.Principal) (Page[Change], error) {
		if _, err := s.load(ctx, q, p, entity, id); err != nil {
			return Page[Change]{}, err
		}
		out, err := q.history(ctx, entity, id, f)
		if p.Profile.Role == "owner" {
			for i := range out.Records {
				out.Records[i].Before = nil
				out.Records[i].After = nil
			}
		}
		return out, err
	})
}

func (s *Service) SetNotificationSink(sink notify.Sink) { s.notifications = sink }
