package events

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode"
	"unicode/utf8"
)

func textOK(v string, max int) bool {
	return utf8.ValidString(v) && utf8.RuneCountInString(v) <= max && !strings.ContainsFunc(v, unicode.IsControl)
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
func validPeriod(start, end time.Time) bool {
	return !start.IsZero() && !end.IsZero() && start.Year() > 0 && end.Year() < 10000 && start.UTC().Year() > 0 && end.UTC().Year() < 10000 && !end.Before(start)
}
func location(name string) (*time.Location, error) {
	if name == "" || name == "Local" || !textOK(name, 100) {
		return nil, invalid("timezone", "Выберите часовой пояс из списка.")
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, invalid("timezone", "Такого часового пояса нет. Выберите его из списка.")
	}
	return loc, nil
}

// fail returns the collected field errors, or nil when there are none.
func fail(fields []FieldError) error {
	if len(fields) == 0 {
		return nil
	}
	return &ValidationError{fields}
}

// tooLong names the limit so the person knows how much to shorten.
func tooLong(field string, max int) FieldError {
	return FieldError{field, fmt.Sprintf("Не больше %d символов, без служебных символов вроде табуляции.", max)}
}

func validateVenue(in *VenueInput) error {
	in.Name = strings.TrimSpace(in.Name)
	in.Locality = strings.TrimSpace(in.Locality)
	in.Street = strings.TrimSpace(in.Street)
	in.BuildingNumber = strings.TrimSpace(in.BuildingNumber)
	in.Room = strings.TrimSpace(in.Room)
	var fields []FieldError
	if in.Name == "" {
		fields = append(fields, FieldError{"name", "Укажите название площадки."})
	}
	if in.Locality == "" {
		fields = append(fields, FieldError{"locality", "Укажите населённый пункт."})
	}
	for _, v := range []struct {
		field, value string
		max          int
	}{{"name", in.Name, 150}, {"locality", in.Locality, 100}, {"street", in.Street, 100}, {"building_number", in.BuildingNumber, 20}, {"room", in.Room, 20}} {
		if !textOK(v.value, v.max) {
			fields = append(fields, tooLong(v.field, v.max))
		}
	}
	return fail(fields)
}
func validateEvent(in *EventInput) error {
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	in.Timezone = strings.TrimSpace(in.Timezone)
	var fields []FieldError
	if in.Name == "" {
		fields = append(fields, FieldError{"name", "Укажите название мероприятия."})
	} else if !textOK(in.Name, 100) {
		fields = append(fields, tooLong("name", 100))
	}
	if !textOK(in.Description, 4000) {
		fields = append(fields, tooLong("description", 4000))
	}
	if in.TypeID < 1 {
		fields = append(fields, FieldError{"type_id", "Выберите тип мероприятия."})
	}
	if in.VenueID < 1 {
		fields = append(fields, FieldError{"venue_id", "Выберите площадку."})
	}
	if in.Audience != "dogs" && in.Audience != "people" && in.Audience != "mixed" {
		fields = append(fields, FieldError{"audience", "Выберите, кто участвует: собаки, люди или собаки и люди."})
	} else if in.Audience == "people" && in.UsesClasses {
		fields = append(fields, FieldError{"uses_classes", "Классы собак не применяются, если участвуют только люди. Снимите отметку."})
	}
	if in.StartsAt.IsZero() || in.StartsAt.Year() < 1 {
		fields = append(fields, FieldError{"starts_at", "Укажите дату и время начала."})
	}
	if in.EndsAt.IsZero() || in.EndsAt.Year() > 9999 {
		fields = append(fields, FieldError{"ends_at", "Укажите дату и время окончания."})
	} else if !in.StartsAt.IsZero() && in.EndsAt.Before(in.StartsAt) {
		fields = append(fields, FieldError{"ends_at", "Окончание не может быть раньше начала."})
	}
	if loc, err := location(in.Timezone); err != nil {
		var v *ValidationError
		if errors.As(err, &v) {
			fields = append(fields, v.Fields...)
		}
	} else if validPeriod(in.StartsAt, in.EndsAt) && (in.StartsAt.In(loc).Year() < 1 || in.EndsAt.In(loc).Year() > 9999) {
		fields = append(fields, FieldError{"starts_at", "Проверьте год: даты должны быть в пределах 1–9999 года."})
	}
	return fail(fields)
}
func validateClass(in *ClassInput) error {
	in.Name = strings.TrimSpace(in.Name)
	in.Requirements = strings.TrimSpace(in.Requirements)
	var fields []FieldError
	if in.Name == "" {
		fields = append(fields, FieldError{"name", "Укажите название класса."})
	} else if !textOK(in.Name, 100) {
		fields = append(fields, tooLong("name", 100))
	}
	if !textOK(in.Requirements, 2000) {
		fields = append(fields, tooLong("requirements", 2000))
	}
	for _, v := range []struct {
		field string
		value *int32
	}{{"min_age_months", in.MinAgeMonths}, {"max_age_months", in.MaxAgeMonths}} {
		if v.value != nil && (*v.value < 0 || *v.value > 1200) {
			fields = append(fields, FieldError{v.field, "Укажите целое число месяцев от 0 до 1200."})
		}
	}
	if in.MinAgeMonths != nil && in.MaxAgeMonths != nil && *in.MinAgeMonths > *in.MaxAgeMonths {
		fields = append(fields, FieldError{"max_age_months", "Верхняя граница возраста не может быть меньше нижней."})
	}
	if in.Requirements != "" && !in.RequiresExpert {
		fields = append(fields, FieldError{"requires_expert", "Если заданы требования, включите решение эксперта по квалификации."})
	}
	return fail(fields)
}
func validateRegistration(in RegistrationInput) error {
	if in.MemberID < 1 {
		return invalid("member_id", "Выберите участника.")
	}
	if in.DogID != nil && *in.DogID < 1 {
		return invalid("dog_id", "Выберите собаку из списка.")
	}
	if in.ClassID != nil && *in.ClassID < 1 {
		return invalid("class_id", "Выберите класс из списка.")
	}
	if in.ScheduleID != nil && *in.ScheduleID < 1 {
		return invalid("schedule_id", "Выберите время выступления из списка.")
	}
	if in.DogID == nil && in.ClassID != nil {
		return invalid("class_id", "Класс выбирают только для участия с собакой.")
	}
	return nil
}
func validateResult(in *ResultInput) error {
	in.Comment = strings.TrimSpace(in.Comment)
	var fields []FieldError
	if in.GradeID != nil && *in.GradeID < 1 {
		fields = append(fields, FieldError{"grade_id", "Выберите оценку из списка."})
	}
	if in.Place != nil && *in.Place < 1 {
		fields = append(fields, FieldError{"place", "Место — целое число от 1."})
	}
	if !textOK(in.Comment, 2000) {
		fields = append(fields, tooLong("comment", 2000))
	}
	if len(fields) == 0 && in.GradeID == nil && in.Place == nil && in.Comment == "" {
		fields = append(fields, FieldError{"grade_id", "Укажите оценку, место или комментарий эксперта."})
	}
	return fail(fields)
}
func classByID(e Event, id *int64) *Class {
	if id != nil {
		for _, c := range e.Classes {
			if c.ID == *id {
				return &c
			}
		}
	}
	return nil
}
func slotByID(e Event, id *int64) *Schedule {
	if id != nil {
		for _, s := range e.Schedule {
			if s.ID == *id {
				return &s
			}
		}
	}
	return nil
}
func sameID(a, b *int64) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }

// Calendar anniversaries clamp the day at the target month's end.
func anniversary(birth string, months int32) (string, error) {
	d, err := time.Parse(time.DateOnly, birth)
	if err != nil || d.Year() < 1 {
		return "", invalid("date_of_birth", "Некорректная дата рождения.")
	}
	base := time.Date(d.Year(), d.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, int(months), 0)
	day := d.Day()
	last := base.AddDate(0, 1, -1).Day()
	if day > last {
		day = last
	}
	date := base.AddDate(0, 0, day-1)
	if date.Year() > 9999 {
		return "", invalid("age", "Возрастная граница выходит за диапазон дат.")
	}
	return date.Format(time.DateOnly), nil
}
func ageAllowed(birth, date string, c *Class) (bool, error) {
	if birth > date {
		return false, nil
	}
	if c == nil {
		return true, nil
	}
	if c.MinAgeMonths != nil {
		min, err := anniversary(birth, *c.MinAgeMonths)
		if err != nil {
			return false, err
		}
		if date < min {
			return false, nil
		}
	}
	if c.MaxAgeMonths != nil {
		max, err := anniversary(birth, *c.MaxAgeMonths)
		if err != nil {
			return false, err
		}
		if date > max {
			return false, nil
		}
	}
	return true, nil
}
func fingerprint(e Event, r Registration, start, end time.Time, c *Class, dogVersion int64) string {
	var scheduleVersion int64
	if slot := slotByID(e, r.ScheduleID); slot != nil {
		scheduleVersion = slot.Version
	}
	value := struct {
		EventID         int32
		TypeID          int32
		Audience        *string
		UsesClasses     bool
		Timezone        *string
		MemberID        int32
		DogID           *int32
		Start, End      string
		Class           *Class
		DogVersion      int64
		RulesVersion    int64
		ScheduleVersion int64
	}{e.ID, e.Type.ID, e.Audience, e.UsesClasses, e.Timezone, r.MemberID, r.DogID, start.UTC().Format(time.RFC3339Nano), end.UTC().Format(time.RFC3339Nano), c, dogVersion, e.RulesVersion, scheduleVersion}
	data, _ := json.Marshal(value)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}
func pageValid(f Filter) error {
	if f.After < 0 || f.Limit < 1 || f.Limit > 100 || f.TypeID < 0 || f.DogID < 0 || !textOK(f.Query, 100) {
		return invalid("query", "Проверьте фильтры и параметры страницы.")
	}
	if f.From != nil && f.To != nil && f.To.Before(*f.From) {
		return invalid("period", "Конец фильтра не может быть раньше начала.")
	}
	return nil
}
func editable(e Event) error {
	if e.Status == "completed" || e.Status == "cancelled" {
		return ErrConflict
	}
	return nil
}
func version(got, want int64) error {
	if want < 1 {
		return invalid("version", "Обновите страницу и повторите действие.")
	}
	if got != want {
		return ErrConflict
	}
	return nil
}
