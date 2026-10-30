package veterinary

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/dogs"
	"dogclub.local/backend/internal/members"
	"github.com/jackc/pgx/v5"
)

type Service struct {
	access  *auth.Service
	dogs    *dogs.Service
	members *members.Service
	now     func() time.Time
}

func NewService(access *auth.Service, dogService *dogs.Service, memberService *members.Service) *Service {
	return &Service{access, dogService, memberService, time.Now}
}

var readRoles = []string{"veterinarian", "staff", "leader", "owner"}

func invalid(field, message string) error { return &ValidationError{[]FieldError{{field, message}}} }
func validText(s string, max int) bool {
	return utf8.ValidString(s) && utf8.RuneCountInString(s) <= max && !strings.ContainsFunc(s, unicode.IsControl)
}
func parseDate(s string) (time.Time, error) {
	d, err := time.Parse(time.DateOnly, s)
	if err != nil || d.Year() < 1 {
		return time.Time{}, invalid("date", "Укажите существующую дату.")
	}
	return d, nil
}
func clinicalDate(date, birth string, now time.Time) error {
	if _, err := parseDate(date); err != nil {
		return err
	}
	if date < birth || date > now.UTC().Format(time.DateOnly) {
		return invalid("date", "Дата должна быть не раньше рождения собаки и не позже сегодняшней.")
	}
	return nil
}

// validPeriod caps a vaccine period at 100 years: 36500 days or 1200 months.
func validPeriod(p Period) bool {
	return p.Value > 0 && (p.Unit == "days" && p.Value <= 36500 || p.Unit == "months" && p.Value <= 1200)
}
func addPeriod(date string, p Period) (string, error) {
	d, err := parseDate(date)
	if err != nil {
		return "", err
	}
	if !validPeriod(p) {
		return "", invalid("period", "Укажите положительный период в днях или календарных месяцах.")
	}
	if p.Unit == "days" {
		d = d.AddDate(0, 0, int(p.Value))
	} else {
		target := int64(d.Year())*12 + int64(d.Month()) - 1 + int64(p.Value)
		year, month := int(target/12), time.Month(target%12+1)
		if year > 9999 {
			return "", invalid("period", "Результат расчёта выходит за поддерживаемый диапазон дат.")
		}
		last := time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
		day := d.Day()
		if day > last {
			day = last
		}
		d = time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
	}
	if d.Year() > 9999 {
		return "", invalid("period", "Результат расчёта выходит за поддерживаемый диапазон дат.")
	}
	return d.Format(time.DateOnly), nil
}
func correction(version int64, reason *string) error {
	*reason = strings.TrimSpace(*reason)
	if version < 1 {
		return invalid("version", "Обновите страницу и повторите действие.")
	}
	if *reason == "" || !validText(*reason, 500) {
		return invalid("reason", "Укажите причину исправления длиной до 500 символов.")
	}
	return nil
}
func ownRecord(p auth.Principal, a Author, version, expected int64, isVoid bool) error {
	if a.UserID == nil || *a.UserID != p.User.ID {
		return auth.ErrForbidden
	}
	if isVoid || version != expected {
		return ErrConflict
	}
	return nil
}
func dogError(err error) error {
	if errors.Is(err, dogs.ErrNotFound) {
		return ErrNotFound
	}
	if errors.Is(err, dogs.ErrUnavailable) {
		return ErrUnavailable
	}
	var v *dogs.ValidationError
	if errors.As(err, &v) {
		return invalid("query", "Проверьте параметры поиска и страницы.")
	}
	return err
}
func (s *Service) veterinarian(ctx context.Context, tx pgx.Tx, p auth.Principal) error {
	if err := auth.RequireProfile(p, "veterinarian"); err != nil {
		return err
	}
	if p.User.ClubMemberID == nil {
		return auth.ErrForbidden
	}
	if err := s.members.ValidateReferences(ctx, tx, []int32{*p.User.ClubMemberID}); err != nil {
		return ErrUnavailable
	}
	return nil
}
func withDog[T any](ctx context.Context, s *Service, p auth.Principal, dogID int32, write bool, fn func(context.Context, *repository, auth.Principal, dogs.Summary) (T, error)) (T, error) {
	var out T
	roles := readRoles
	if write {
		roles = []string{"veterinarian"}
	}
	err := s.access.WithAccess(ctx, p, roles, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		if write {
			if err := s.veterinarian(ctx, tx, current); err != nil {
				return err
			}
		}
		dog, err := s.dogs.ReadForVeterinary(ctx, tx, current, dogID)
		if err != nil {
			return dogError(err)
		}
		out, err = fn(ctx, &repository{tx}, current, dog)
		return err
	})
	return out, err
}

// activeDog applies lab 3 fn_dog_active_check to new and corrected clinical facts.
// Voiding stays available so that erroneous records can still be withdrawn.
func activeDog(dog dogs.Summary) error {
	if dog.Inactive() {
		return invalid("dog_id", fmt.Sprintf("Собака имеет статус «%s»: медицинские записи не добавляются и не исправляются.", dog.Status.Name))
	}
	return nil
}

// noActiveVaccination applies lab 3 fn_prevent_active_vaccination: revaccination
// windows [date, next_date) of one product never overlap for the same dog.
func noActiveVaccination(ctx context.Context, q *repository, dogID, id int32, typeID int32, date, next string) error {
	other, otherNext, found, err := q.overlappingVaccination(ctx, dogID, id, typeID, date, next)
	if err != nil || !found {
		return err
	}
	return invalid("date", fmt.Sprintf("Вакцинация этим препаратом от %s ещё действует до %s; новую дозу можно внести с этой даты.", other, otherNext))
}
func validPage(f PageFilter, serial bool) error {
	if f.After < 0 || f.Limit < 1 || f.Limit > 100 || (serial && f.After > 2147483647) {
		return invalid("query", "Не удалось загрузить список. Обновите страницу.")
	}
	return nil
}
func (s *Service) Patients(ctx context.Context, p auth.Principal, f dogs.Filter) (dogs.Page, error) {
	var out dogs.Page
	err := s.access.WithAccess(ctx, p, readRoles, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		var err error
		out, err = s.dogs.ListForVeterinary(ctx, tx, current, f)
		return dogError(err)
	})
	return out, err
}
func (s *Service) Dictionaries(ctx context.Context, p auth.Principal) (Dictionaries, error) {
	var out Dictionaries
	err := s.access.WithAccess(ctx, p, readRoles, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		if current.Profile.Role == "owner" {
			if _, err := s.members.RequireActiveOwner(ctx, tx, current); err != nil {
				if errors.Is(err, members.ErrUnavailable) {
					return ErrUnavailable
				}
				return err
			}
		}
		var err error
		out, err = (&repository{tx}).dictionaries(ctx)
		return err
	})
	return out, err
}
func (s *Service) GetVaccineType(ctx context.Context, p auth.Principal, id int32) (VaccineType, error) {
	var out VaccineType
	err := s.access.WithAccess(ctx, p, readRoles, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		if current.Profile.Role == "owner" {
			if _, err := s.members.RequireActiveOwner(ctx, tx, current); err != nil {
				if errors.Is(err, members.ErrUnavailable) {
					return ErrUnavailable
				}
				return err
			}
		}
		var err error
		out, err = (&repository{tx}).vaccineType(ctx, id)
		return err
	})
	return out, err
}
func validateVaccineType(in *VaccineTypeInput) error {
	in.Name = strings.TrimSpace(in.Name)
	in.Maker = strings.TrimSpace(in.Maker)
	var fields []FieldError
	if in.Name == "" || !validText(in.Name, 100) {
		fields = append(fields, FieldError{"name", "Укажите название препарата, не больше 100 символов."})
	}
	if !validText(in.Maker, 100) {
		fields = append(fields, FieldError{"maker", "Производитель — не больше 100 символов."})
	}
	if len(fields) > 0 {
		return &ValidationError{fields}
	}
	for _, v := range []struct {
		name string
		p    Period
	}{{"validity", in.Validity}, {"revaccination", in.Revaccination}} {
		if !validPeriod(v.p) {
			return invalid(v.name, "Укажите целое число: от 1 до 36 500 дней или от 1 до 1200 месяцев.")
		}
		if _, err := addPeriod("2000-01-01", v.p); err != nil {
			return invalid(v.name, "Период выходит за поддерживаемый диапазон дат.")
		}
	}
	return nil
}
func (s *Service) CreateVaccineType(ctx context.Context, p auth.Principal, in VaccineTypeInput) (VaccineType, error) {
	if err := validateVaccineType(&in); err != nil {
		return VaccineType{}, err
	}
	var out VaccineType
	err := s.access.WithAccess(ctx, p, []string{"veterinarian"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		if err := s.veterinarian(ctx, tx, current); err != nil {
			return err
		}
		q := &repository{tx}
		id, err := q.saveVaccineType(ctx, 0, 0, in)
		if err != nil {
			return err
		}
		out, err = q.vaccineType(ctx, id)
		if err != nil {
			return err
		}
		return q.record(ctx, current, nil, "vaccine_type", int64(id), "created", "", nil, out)
	})
	return out, err
}
func (s *Service) UpdateVaccineType(ctx context.Context, p auth.Principal, id int32, in VaccineTypeUpdate) (VaccineType, error) {
	if err := correction(in.Version, &in.Reason); err != nil {
		return VaccineType{}, err
	}
	if err := validateVaccineType(&in.VaccineTypeInput); err != nil {
		return VaccineType{}, err
	}
	var out VaccineType
	err := s.access.WithAccess(ctx, p, []string{"veterinarian"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		if err := s.veterinarian(ctx, tx, current); err != nil {
			return err
		}
		q := &repository{tx}
		before, err := q.vaccineType(ctx, id)
		if err != nil {
			return err
		}
		if _, err := q.saveVaccineType(ctx, id, in.Version, in.VaccineTypeInput); err != nil {
			return err
		}
		out, err = q.vaccineType(ctx, id)
		if err != nil {
			return err
		}
		return q.record(ctx, current, nil, "vaccine_type", int64(id), "corrected", in.Reason, before, out)
	})
	return out, err
}
func (s *Service) VaccineTypeHistory(ctx context.Context, p auth.Principal, id int32, f PageFilter) (Page[Change], error) {
	if err := validPage(f, false); err != nil {
		return Page[Change]{}, err
	}
	var out Page[Change]
	err := s.access.WithAccess(ctx, p, []string{"veterinarian", "staff", "leader"}, func(ctx context.Context, tx pgx.Tx, _ auth.Principal) error {
		q := &repository{tx}
		if _, err := q.vaccineType(ctx, id); err != nil {
			return err
		}
		var err error
		out, err = q.history(ctx, nil, &id, f)
		return err
	})
	return out, err
}
func validateExamination(in *ExaminationInput, birth string, now time.Time) error {
	if err := clinicalDate(in.Date, birth, now); err != nil {
		return err
	}
	for _, v := range []struct {
		name  string
		value *string
	}{{"description", &in.Description}, {"result", &in.Result}, {"recommendations", &in.Recommendations}} {
		*v.value = strings.TrimSpace(*v.value)
		if !validText(*v.value, 4000) {
			return invalid(v.name, "Не больше 4000 символов.")
		}
	}
	if len(in.Diagnoses) > 100 {
		return invalid("diagnoses", "Допускается до 100 различных диагнозов.")
	}
	seen := map[int32]bool{}
	for _, d := range in.Diagnoses {
		if d.DiseaseID < 1 || seen[d.DiseaseID] {
			return invalid("diagnoses", "Укажите существующие заболевания без повторений.")
		}
		seen[d.DiseaseID] = true
	}
	return nil
}
func (s *Service) CreateExamination(ctx context.Context, p auth.Principal, dogID int32, in ExaminationInput) (Examination, error) {
	return withDog(ctx, s, p, dogID, true, func(ctx context.Context, q *repository, current auth.Principal, dog dogs.Summary) (Examination, error) {
		if err := activeDog(dog); err != nil {
			return Examination{}, err
		}
		if err := validateExamination(&in, dog.DateOfBirth, s.now()); err != nil {
			return Examination{}, err
		}
		id, err := q.saveExamination(ctx, current, dogID, 0, 0, in)
		if err != nil {
			return Examination{}, err
		}
		out, err := q.examination(ctx, dogID, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, current, &dogID, "examination", int64(id), "created", "", nil, out)
	})
}
func (s *Service) UpdateExamination(ctx context.Context, p auth.Principal, dogID, id int32, in ExaminationUpdate) (Examination, error) {
	if err := correction(in.Version, &in.Reason); err != nil {
		return Examination{}, err
	}
	return withDog(ctx, s, p, dogID, true, func(ctx context.Context, q *repository, current auth.Principal, dog dogs.Summary) (Examination, error) {
		before, err := q.examination(ctx, dogID, id)
		if err != nil {
			return Examination{}, err
		}
		if err := ownRecord(current, before.Author, before.Version, in.Version, before.IsVoid); err != nil {
			return Examination{}, err
		}
		if err := activeDog(dog); err != nil {
			return Examination{}, err
		}
		if err := validateExamination(&in.ExaminationInput, dog.DateOfBirth, s.now()); err != nil {
			return Examination{}, err
		}
		if _, err := q.saveExamination(ctx, current, dogID, id, in.Version, in.ExaminationInput); err != nil {
			return Examination{}, err
		}
		out, err := q.examination(ctx, dogID, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, current, &dogID, "examination", int64(id), "corrected", in.Reason, before, out)
	})
}
func (s *Service) GetExamination(ctx context.Context, p auth.Principal, dogID, id int32) (Examination, error) {
	return withDog(ctx, s, p, dogID, false, func(ctx context.Context, q *repository, _ auth.Principal, _ dogs.Summary) (Examination, error) {
		return q.examination(ctx, dogID, id)
	})
}
func (s *Service) CreateVaccination(ctx context.Context, p auth.Principal, dogID int32, in VaccinationInput) (Vaccination, error) {
	return withDog(ctx, s, p, dogID, true, func(ctx context.Context, q *repository, current auth.Principal, dog dogs.Summary) (Vaccination, error) {
		if err := activeDog(dog); err != nil {
			return Vaccination{}, err
		}
		vaccine, until, next, err := s.calculateVaccination(ctx, q, in, dog.DateOfBirth)
		if err != nil {
			return Vaccination{}, err
		}
		if err := noActiveVaccination(ctx, q, dogID, 0, in.VaccineTypeID, in.Date, next); err != nil {
			return Vaccination{}, err
		}
		if err := q.validateReminderReplacements(ctx, dogID, 0, in); err != nil {
			return Vaccination{}, err
		}
		id, err := q.saveVaccination(ctx, current, dogID, 0, 0, in, vaccine, until, next)
		if err != nil {
			return Vaccination{}, err
		}
		if err := q.saveReminderReplacements(ctx, dogID, id, in.ReplacesVaccinationIDs); err != nil {
			return Vaccination{}, err
		}
		out, err := q.vaccination(ctx, dogID, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, current, &dogID, "vaccination", int64(id), "created", "", nil, out)
	})
}
func (s *Service) calculateVaccination(ctx context.Context, q *repository, in VaccinationInput, birth string) (VaccineType, string, string, error) {
	if err := clinicalDate(in.Date, birth, s.now()); err != nil {
		return VaccineType{}, "", "", err
	}
	if in.VaccineTypeID < 1 {
		return VaccineType{}, "", "", invalid("vaccine_type_id", "Выберите препарат.")
	}
	vaccine, err := q.vaccineType(ctx, in.VaccineTypeID)
	if errors.Is(err, ErrNotFound) {
		err = invalid("vaccine_type_id", "Препарат не найден.")
	}
	if err != nil {
		return vaccine, "", "", err
	}
	if vaccine.Validity == nil || vaccine.Revaccination == nil {
		return vaccine, "", "", invalid("vaccine_type_id", "У препарата не настроены оба периода и их единицы.")
	}
	until, err := addPeriod(in.Date, *vaccine.Validity)
	if err != nil {
		return vaccine, "", "", err
	}
	next, err := addPeriod(in.Date, *vaccine.Revaccination)
	return vaccine, until, next, err
}
func (s *Service) UpdateVaccination(ctx context.Context, p auth.Principal, dogID, id int32, in VaccinationUpdate) (Vaccination, error) {
	if err := correction(in.Version, &in.Reason); err != nil {
		return Vaccination{}, err
	}
	return withDog(ctx, s, p, dogID, true, func(ctx context.Context, q *repository, current auth.Principal, dog dogs.Summary) (Vaccination, error) {
		before, err := q.vaccination(ctx, dogID, id)
		if err != nil {
			return Vaccination{}, err
		}
		if err := ownRecord(current, before.Author, before.Version, in.Version, before.IsVoid); err != nil {
			return Vaccination{}, err
		}
		if err := activeDog(dog); err != nil {
			return Vaccination{}, err
		}
		vaccine := before.Vaccine
		until, next := before.ValidUntil, before.NextDate
		if before.Date != in.Date || before.Vaccine.ID != in.VaccineTypeID {
			var u, n string
			vaccine, u, n, err = s.calculateVaccination(ctx, q, in.VaccinationInput, dog.DateOfBirth)
			if err != nil {
				return Vaccination{}, err
			}
			if err := noActiveVaccination(ctx, q, dogID, id, in.VaccineTypeID, in.Date, n); err != nil {
				return Vaccination{}, err
			}
			until, next = &u, &n
		}
		if until == nil || next == nil {
			return Vaccination{}, invalid("fields", "Для пересчёта укажите дату и настроенный препарат.")
		}
		if in.ReplacesVaccinationIDs == nil {
			in.ReplacesVaccinationIDs = before.ReplacesVaccinationIDs
		}
		if err := q.validateReminderReplacements(ctx, dogID, id, in.VaccinationInput); err != nil {
			return Vaccination{}, err
		}
		if _, err := q.saveVaccination(ctx, current, dogID, id, in.Version, in.VaccinationInput, vaccine, *until, *next); err != nil {
			return Vaccination{}, err
		}
		if err := q.saveReminderReplacements(ctx, dogID, id, in.ReplacesVaccinationIDs); err != nil {
			return Vaccination{}, err
		}
		out, err := q.vaccination(ctx, dogID, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, current, &dogID, "vaccination", int64(id), "corrected", in.Reason, before, out)
	})
}
func (s *Service) GetVaccination(ctx context.Context, p auth.Principal, dogID, id int32) (Vaccination, error) {
	return withDog(ctx, s, p, dogID, false, func(ctx context.Context, q *repository, _ auth.Principal, _ dogs.Summary) (Vaccination, error) {
		return q.vaccination(ctx, dogID, id)
	})
}

func validateClearance(in *ClearanceInput) error {
	in.Comment = strings.TrimSpace(in.Comment)
	if !validText(in.Comment, 4000) {
		return invalid("comment", "Комментарий — не больше 4000 символов.")
	}
	if in.ExaminationID < 1 {
		return invalid("examination_id", "Выберите осмотр этой собаки.")
	}
	if in.Purpose != "events" && in.Purpose != "breeding" {
		return invalid("purpose", "Выберите назначение заключения: мероприятия или вязка.")
	}
	switch in.Decision {
	case "allowed":
		if in.ValidUntil == nil {
			return invalid("valid_until", "Укажите срок разрешения.")
		}
		if _, err := parseDate(*in.ValidUntil); err != nil {
			return invalid("valid_until", "Укажите существующую дату.")
		}
		if len(in.VaccinationIDs) == 0 || len(in.VaccinationIDs) > 100 {
			return invalid("vaccination_ids", "Укажите от одной до 100 необходимых записей вакцинации.")
		}
	case "denied", "not_assessed":
		if in.ValidUntil != nil || len(in.VaccinationIDs) > 0 {
			return invalid("decision", "Срок и основания вакцинации указываются только для разрешения.")
		}
	default:
		return invalid("decision", "Выберите решение: допущена, не допущена или не оценено.")
	}
	seen := map[int32]bool{}
	for _, id := range in.VaccinationIDs {
		if id < 1 || seen[id] {
			return invalid("vaccination_ids", "Выберите прививки из списка, без повторов.")
		}
		seen[id] = true
	}
	return nil
}
func (s *Service) clearanceReferences(ctx context.Context, q *repository, p auth.Principal, dogID int32, in ClearanceInput) error {
	exam, err := q.examination(ctx, dogID, in.ExaminationID)
	if errors.Is(err, ErrNotFound) {
		return invalid("examination_id", "Осмотр этой собаки не найден.")
	}
	if err != nil {
		return err
	}
	if exam.Author.UserID == nil || *exam.Author.UserID != p.User.ID {
		return auth.ErrForbidden
	}
	if exam.IsVoid {
		return invalid("examination_id", "Осмотр отмечен недействительным.")
	}
	if in.ValidUntil != nil && *in.ValidUntil < exam.Date {
		return invalid("valid_until", "Разрешение не может окончиться до осмотра.")
	}
	for _, id := range in.VaccinationIDs {
		v, err := q.vaccination(ctx, dogID, id)
		if errors.Is(err, ErrNotFound) {
			return invalid("vaccination_ids", "Вакцинация этой собаки не найдена.")
		}
		if err != nil {
			return err
		}
		if v.IsVoid || v.ValidUntil == nil || v.Date > exam.Date || *v.ValidUntil < exam.Date {
			return invalid("vaccination_ids", "Основания должны быть действительными на дату осмотра и иметь известный срок.")
		}
	}
	return nil
}
func (s *Service) CreateClearance(ctx context.Context, p auth.Principal, dogID int32, in ClearanceInput) (Clearance, error) {
	if err := validateClearance(&in); err != nil {
		return Clearance{}, err
	}
	return withDog(ctx, s, p, dogID, true, func(ctx context.Context, q *repository, current auth.Principal, _ dogs.Summary) (Clearance, error) {
		if err := s.clearanceReferences(ctx, q, current, dogID, in); err != nil {
			return Clearance{}, err
		}
		id, err := q.saveClearance(ctx, current, dogID, 0, 0, in)
		if err != nil {
			return Clearance{}, err
		}
		out, err := q.clearance(ctx, dogID, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, current, &dogID, "clearance", id, "created", "", nil, out)
	})
}
func (s *Service) UpdateClearance(ctx context.Context, p auth.Principal, dogID int32, id int64, in ClearanceUpdate) (Clearance, error) {
	if err := correction(in.Version, &in.Reason); err != nil {
		return Clearance{}, err
	}
	if err := validateClearance(&in.ClearanceInput); err != nil {
		return Clearance{}, err
	}
	return withDog(ctx, s, p, dogID, true, func(ctx context.Context, q *repository, current auth.Principal, _ dogs.Summary) (Clearance, error) {
		before, err := q.clearance(ctx, dogID, id)
		if err != nil {
			return Clearance{}, err
		}
		if err := ownRecord(current, before.Author, before.Version, in.Version, before.IsVoid); err != nil {
			return Clearance{}, err
		}
		// Moving a decision to a different purpose/examination could resurrect an
		// older permission. Correct the record explicitly and issue a new decision.
		if in.Purpose != before.Purpose || in.ExaminationID != before.ExaminationID {
			return Clearance{}, invalid("fields", "Назначение и осмотр заключения не меняются; оформите новую запись.")
		}
		if err := s.clearanceReferences(ctx, q, current, dogID, in.ClearanceInput); err != nil {
			return Clearance{}, err
		}
		if _, err := q.saveClearance(ctx, current, dogID, id, in.Version, in.ClearanceInput); err != nil {
			return Clearance{}, err
		}
		out, err := q.clearance(ctx, dogID, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, current, &dogID, "clearance", id, "corrected", in.Reason, before, out)
	})
}
func (s *Service) GetClearance(ctx context.Context, p auth.Principal, dogID int32, id int64) (Clearance, error) {
	return withDog(ctx, s, p, dogID, false, func(ctx context.Context, q *repository, _ auth.Principal, _ dogs.Summary) (Clearance, error) {
		return q.clearance(ctx, dogID, id)
	})
}
func (s *Service) Void(ctx context.Context, p auth.Principal, dogID int32, entity string, id int64, in CorrectionInput) (any, error) {
	if entity != "examination" && entity != "vaccination" && entity != "clearance" {
		return nil, ErrNotFound
	}
	if err := correction(in.Version, &in.Reason); err != nil {
		return nil, err
	}
	return withDog(ctx, s, p, dogID, true, func(ctx context.Context, q *repository, current auth.Principal, _ dogs.Summary) (any, error) {
		load := func() (any, Author, int64, bool, error) {
			switch entity {
			case "examination":
				v, err := q.examination(ctx, dogID, int32(id))
				return v, v.Author, v.Version, v.IsVoid, err
			case "vaccination":
				v, err := q.vaccination(ctx, dogID, int32(id))
				return v, v.Author, v.Version, v.IsVoid, err
			default:
				v, err := q.clearance(ctx, dogID, id)
				return v, v.Author, v.Version, v.IsVoid, err
			}
		}
		if id < 1 || (entity != "clearance" && id > 2147483647) {
			return nil, invalid("id", "Запись не найдена. Откройте её из списка.")
		}
		before, a, version, void, err := load()
		if err != nil {
			return nil, err
		}
		if err := ownRecord(current, a, version, in.Version, void); err != nil {
			return nil, err
		}
		if err := q.void(ctx, entity, dogID, id, in.Version); err != nil {
			return nil, err
		}
		after, _, _, _, err := load()
		if err != nil {
			return nil, err
		}
		return after, q.record(ctx, current, &dogID, entity, id, "voided", in.Reason, before, after)
	})
}
func listRecords[T any](ctx context.Context, s *Service, p auth.Principal, dogID int32, entity string, f PageFilter, load func(context.Context, *repository, int32, int64) (T, error)) (Page[T], error) {
	if err := validPage(f, entity != "clearance"); err != nil {
		return Page[T]{}, err
	}
	return withDog(ctx, s, p, dogID, false, func(ctx context.Context, q *repository, _ auth.Principal, _ dogs.Summary) (Page[T], error) {
		out := Page[T]{Records: []T{}}
		ids, err := q.ids(ctx, entity, dogID, f)
		if err != nil {
			return out, err
		}
		if len(ids) > f.Limit {
			ids = ids[:f.Limit]
			last := ids[len(ids)-1]
			out.NextAfter = &last
		}
		for _, id := range ids {
			v, err := load(ctx, q, dogID, id)
			if err != nil {
				return out, err
			}
			out.Records = append(out.Records, v)
		}
		return out, nil
	})
}
func (s *Service) Examinations(ctx context.Context, p auth.Principal, dogID int32, f PageFilter) (Page[Examination], error) {
	return listRecords(ctx, s, p, dogID, "examination", f, func(ctx context.Context, q *repository, dogID int32, id int64) (Examination, error) {
		return q.examination(ctx, dogID, int32(id))
	})
}
func (s *Service) Vaccinations(ctx context.Context, p auth.Principal, dogID int32, f PageFilter) (Page[Vaccination], error) {
	return listRecords(ctx, s, p, dogID, "vaccination", f, func(ctx context.Context, q *repository, dogID int32, id int64) (Vaccination, error) {
		return q.vaccination(ctx, dogID, int32(id))
	})
}
func (s *Service) Clearances(ctx context.Context, p auth.Principal, dogID int32, f PageFilter) (Page[Clearance], error) {
	return listRecords(ctx, s, p, dogID, "clearance", f, func(ctx context.Context, q *repository, dogID int32, id int64) (Clearance, error) {
		return q.clearance(ctx, dogID, id)
	})
}
func (s *Service) History(ctx context.Context, p auth.Principal, dogID int32, f PageFilter) (Page[Change], error) {
	if err := validPage(f, false); err != nil {
		return Page[Change]{}, err
	}
	return withDog(ctx, s, p, dogID, false, func(ctx context.Context, q *repository, _ auth.Principal, _ dogs.Summary) (Page[Change], error) {
		return q.history(ctx, &dogID, nil, f)
	})
}
func evaluateAdmission(today string, c Clearance, exam Examination, vaccinations []Vaccination) Admission {
	out := Admission{Decision: c.Decision, ClearanceID: &c.ID, ValidUntil: c.ValidUntil, Reasons: []StatusReason{}}
	add := func(code string, id *int32) { out.Reasons = append(out.Reasons, StatusReason{code, id}) }
	if c.IsVoid {
		add("clearance_voided", nil)
	}
	if exam.IsVoid {
		add("examination_voided", nil)
	}
	if len(out.Reasons) > 0 {
		out.Decision = "review_required"
		return out
	}
	if c.Decision != "allowed" {
		add(c.Decision, nil)
		return out
	}
	if c.ValidUntil == nil {
		add("clearance_validity_unknown", nil)
	} else {
		if *c.ValidUntil < today {
			add("clearance_expired", nil)
		}
		if *c.ValidUntil < exam.Date {
			add("clearance_before_examination", nil)
		}
	}
	if len(vaccinations) == 0 {
		add("vaccinations_missing", nil)
	}
	for _, v := range vaccinations {
		id := v.ID
		if v.IsVoid {
			add("vaccination_voided", &id)
		}
		if v.Date > exam.Date {
			add("vaccination_after_examination", &id)
		}
		if v.ValidUntil == nil {
			add("vaccination_validity_unknown", &id)
		} else {
			if out.ValidUntil == nil || *v.ValidUntil < *out.ValidUntil {
				out.ValidUntil = v.ValidUntil
			}
			if *v.ValidUntil < today {
				add("vaccination_expired", &id)
			}
			if *v.ValidUntil < exam.Date {
				add("vaccination_expired_at_examination", &id)
			}
		}
	}
	if len(out.Reasons) > 0 {
		out.Decision = "review_required"
	}
	return out
}
func (s *Service) medicalStatus(ctx context.Context, q *repository, dogID int32) (MedicalStatus, error) {
	out := MedicalStatus{DogID: dogID, AsOf: s.now().UTC().Format(time.DateOnly)}
	for _, entry := range []struct {
		purpose string
		target  *Admission
	}{{"events", &out.Events}, {"breeding", &out.Breeding}} {
		c, err := q.latestClearance(ctx, dogID, entry.purpose)
		if errors.Is(err, ErrNotFound) {
			*entry.target = Admission{Decision: "not_assessed", Reasons: []StatusReason{{Code: "clearance_missing"}}}
			continue
		}
		if err != nil {
			return out, err
		}
		exam, err := q.examination(ctx, dogID, c.ExaminationID)
		if err != nil {
			return out, err
		}
		vaccinations := []Vaccination{}
		for _, id := range c.VaccinationIDs {
			v, err := q.vaccination(ctx, dogID, id)
			if err != nil {
				return out, err
			}
			vaccinations = append(vaccinations, v)
		}
		*entry.target = evaluateAdmission(out.AsOf, c, exam, vaccinations)
	}
	return out, nil
}
func (s *Service) MedicalStatus(ctx context.Context, p auth.Principal, dogID int32) (MedicalStatus, error) {
	return withDog(ctx, s, p, dogID, false, func(ctx context.Context, q *repository, _ auth.Principal, _ dogs.Summary) (MedicalStatus, error) {
		return s.medicalStatus(ctx, q, dogID)
	})
}
