package dogs

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/members"
	"dogclub.local/backend/internal/platform/filestore"
	"dogclub.local/backend/internal/platform/notify"
	"github.com/jackc/pgx/v5"
)

type Service struct {
	training      TrainingPolicy
	notifications notify.Sink
	access        *auth.Service
	members       *members.Service
	dates         MedicalDatesPolicy
	breeding      BreedingPolicy
	events        EventPolicy
	photos        *filestore.Store
	now           func() time.Time
}

// MedicalDatesPolicy is supplied by the veterinary module at composition time.
// It reads that module's data in the current transaction without an import cycle.
type MedicalDatesPolicy interface {
	RecordsBefore(context.Context, pgx.Tx, int32, string) (bool, error)
}

func NewService(access *auth.Service, memberService *members.Service, policies ...MedicalDatesPolicy) *Service {
	s := &Service{access: access, members: memberService, now: time.Now}
	if len(policies) > 0 {
		s.dates = policies[0]
	}
	return s
}

// ReadForVeterinary exposes the animal's summary, never owners' personal data.
// The caller must own auth.WithAccess and pass its current principal/transaction.
func (s *Service) ReadForVeterinary(ctx context.Context, tx pgx.Tx, p auth.Principal, id int32) (Summary, error) {
	if err := auth.RequireProfile(p, "veterinarian", "staff", "leader", "owner"); err != nil {
		return Summary{}, err
	}
	if err := s.readAccess(ctx, tx, p, id); err != nil {
		return Summary{}, err
	}
	return (&repository{tx}).summary(ctx, id)
}

func (s *Service) ListForVeterinary(ctx context.Context, tx pgx.Tx, p auth.Principal, f Filter) (Page, error) {
	if err := auth.RequireProfile(p, "veterinarian", "staff", "leader", "owner"); err != nil {
		return Page{}, err
	}
	f.Query = strings.TrimSpace(f.Query)
	if f.After < 0 || f.Limit < 1 || f.Limit > 100 || f.OwnerID < 0 || f.BreedID < 0 || f.StatusID < 0 || f.SexID < 0 || !validText(f.Query, 100) {
		return Page{}, invalid("query", "Проверьте параметры поиска и страницы.")
	}
	memberID, err := s.owner(ctx, tx, p)
	if err != nil {
		return Page{}, err
	}
	if memberID != 0 {
		if f.OwnerID != 0 && f.OwnerID != memberID {
			return Page{}, auth.ErrForbidden
		}
		f.OwnerID = memberID
	}
	return (&repository{tx}).list(ctx, f)
}
func invalid(field, message string) error {
	return &ValidationError{Fields: []FieldError{{field, message}}}
}
func validText(s string, max int) bool {
	return utf8.ValidString(s) && utf8.RuneCountInString(s) <= max && !strings.ContainsFunc(s, unicode.IsControl)
}
func dateValid(s string, now time.Time) bool {
	d, e := time.Parse(time.DateOnly, s)
	return e == nil && d.Year() > 0 && s <= now.UTC().Format(time.DateOnly)
}
func validateOwners(ids []int32) error {
	if len(ids) == 0 || len(ids) > 100 {
		return invalid("owner_ids", "Укажите от одного до 100 владельцев.")
	}
	seen := map[int32]bool{}
	for _, id := range ids {
		if id < 1 || seen[id] {
			return invalid("owner_ids", "Укажите положительные идентификаторы без повторений.")
		}
		seen[id] = true
	}
	return nil
}
func validateCreate(in *CreateInput, now time.Time) error {
	in.Nickname = strings.TrimSpace(in.Nickname)
	in.Identifier.Number = strings.TrimSpace(in.Identifier.Number)
	fields := make([]FieldError, 0)
	if in.Nickname == "" || !validText(in.Nickname, 100) {
		fields = append(fields, FieldError{"nickname", "Укажите кличку, не больше 100 символов."})
	}
	if !dateValid(in.DateOfBirth, now) || in.DateOfBirth < "1900-01-01" {
		fields = append(fields, FieldError{"date_of_birth", "Укажите дату рождения с 01.01.1900 по сегодня."})
	}
	if in.Identifier.Number == "" || !validText(in.Identifier.Number, 100) {
		fields = append(fields, FieldError{"identifier.number", "Укажите номер, не больше 100 символов."})
	}
	if in.Identifier.Date != nil && (!dateValid(*in.Identifier.Date, now) || *in.Identifier.Date < in.DateOfBirth) {
		fields = append(fields, FieldError{"identifier.date", "Дата идентификации должна быть не раньше рождения и не в будущем."})
	}
	for _, v := range []struct {
		name string
		id   int32
	}{{"identifier.type_id", in.Identifier.TypeID}, {"status_id", in.StatusID}, {"breed_id", in.BreedID}, {"coat_color_id", in.CoatColorID}, {"sex_id", in.SexID}} {
		if v.id < 1 {
			fields = append(fields, FieldError{v.name, "Выберите значение справочника."})
		}
	}
	for _, v := range []struct {
		name    string
		value   *float64
		max     float64
		message string
	}{{"height_cm", in.HeightCM, 150, "Укажите рост от 0.01 до 150 см, не более двух знаков после точки."}, {"weight_kg", in.WeightKG, 200, "Укажите вес от 0.01 до 200 кг, не более двух знаков после точки."}} {
		if v.value != nil {
			x := *v.value
			if math.IsNaN(x) || math.IsInf(x, 0) || x < 0.01 || x > v.max || math.Abs(x*100-math.Round(x*100)) > 1e-7 {
				fields = append(fields, FieldError{v.name, v.message})
			}
		}
	}
	if len(fields) > 0 {
		return &ValidationError{fields}
	}
	return validateOwners(in.OwnerIDs)
}
func (s *Service) validateOwnerReferences(ctx context.Context, tx pgx.Tx, ids []int32) error {
	if err := validateOwners(ids); err != nil {
		return err
	}
	err := s.members.ValidateReferences(ctx, tx, ids)
	var validation *members.ValidationError
	if errors.As(err, &validation) {
		return invalid("owner_ids", "Карточка одного из владельцев не найдена.")
	}
	if err != nil {
		return ErrUnavailable
	}
	return nil
}
func (s *Service) owner(ctx context.Context, tx pgx.Tx, p auth.Principal) (int32, error) {
	if p.Profile.Role != "owner" {
		return 0, nil
	}
	id, err := s.members.RequireActiveOwner(ctx, tx, p)
	if errors.Is(err, members.ErrUnavailable) {
		return 0, ErrUnavailable
	}
	return id, err
}
func (s *Service) readAccess(ctx context.Context, tx pgx.Tx, p auth.Principal, id int32) error {
	memberID, err := s.owner(ctx, tx, p)
	if err != nil {
		return err
	}
	if memberID != 0 {
		return (&repository{tx}).owns(ctx, id, memberID)
	}
	return nil
}
func (s *Service) Get(ctx context.Context, p auth.Principal, id int32) (Dog, error) {
	var result Dog
	err := s.access.WithAccess(ctx, p, []string{"staff", "leader", "owner"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		ctx = notify.WithSink(ctx, s.notifications)
		if err := s.readAccess(ctx, tx, current, id); err != nil {
			return err
		}
		var err error
		result, err = (&repository{tx}).card(ctx, id)
		return err
	})
	return result, err
}
func (s *Service) List(ctx context.Context, p auth.Principal, f Filter) (Page, error) {
	f.Query = strings.TrimSpace(f.Query)
	if f.After < 0 || f.Limit < 1 || f.Limit > 100 || f.OwnerID < 0 || f.BreedID < 0 || f.StatusID < 0 || f.SexID < 0 || !validText(f.Query, 100) {
		return Page{}, invalid("query", "Проверьте поиск, фильтры и параметры страницы.")
	}
	var result Page
	err := s.access.WithAccess(ctx, p, []string{"staff", "leader", "owner"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		ctx = notify.WithSink(ctx, s.notifications)
		memberID, err := s.owner(ctx, tx, current)
		if err != nil {
			return err
		}
		if memberID != 0 {
			if f.OwnerID != 0 && f.OwnerID != memberID {
				return auth.ErrForbidden
			}
			f.OwnerID = memberID
		}
		result, err = (&repository{tx}).list(ctx, f)
		return err
	})
	return result, err
}
func (s *Service) Create(ctx context.Context, p auth.Principal, in CreateInput) (Dog, error) {
	if err := validateCreate(&in, s.now()); err != nil {
		return Dog{}, err
	}
	var result Dog
	err := s.access.WithAccess(ctx, p, []string{"staff"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		ctx = notify.WithSink(ctx, s.notifications)
		if err := s.validateOwnerReferences(ctx, tx, in.OwnerIDs); err != nil {
			return err
		}
		q := &repository{tx}
		id, err := q.create(ctx, in)
		if err != nil {
			return err
		}
		if err := q.owners(ctx, id, in.OwnerIDs); err != nil {
			return err
		}
		result, err = q.card(ctx, id)
		if err != nil {
			return err
		}
		return q.record(ctx, current, "dog_created", "", nil, result)
	})
	return result, err
}
func (s *Service) mutate(ctx context.Context, p auth.Principal, id int32, version int64, action, reason string, fn func(context.Context, *repository, Dog) error) (Dog, error) {
	if version < 1 {
		return Dog{}, invalid("version", "Укажите текущую версию карточки.")
	}
	var result Dog
	err := s.access.WithAccess(ctx, p, []string{"staff"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		ctx = notify.WithSink(ctx, s.notifications)
		q := &repository{tx}
		before, err := q.card(ctx, id)
		if err != nil {
			return err
		}
		if err := q.bump(ctx, id, version); err != nil {
			return err
		}
		if err := fn(ctx, q, before); err != nil {
			return err
		}
		result, err = q.card(ctx, id)
		if err != nil {
			return err
		}
		if s.breeding != nil {
			ok, e := s.breeding.Consistent(ctx, tx, before, result)
			if e != nil {
				return ErrUnavailable
			}
			if !ok {
				return invalid("fields", "Изменение противоречит зарегистрированной вязке или помёту.")
			}
		}
		if s.events != nil {
			ok, e := s.events.Consistent(ctx, tx, before, result)
			if e != nil {
				return ErrUnavailable
			}
			if !ok {
				return invalid("date_of_birth", "Дата рождения противоречит зарегистрированному участию в мероприятии.")
			}
		}
		if s.training != nil {
			ok, e := s.training.Consistent(ctx, tx, before, result)
			if e != nil {
				return ErrUnavailable
			}
			if !ok {
				return invalid("date_of_birth", "Дата рождения противоречит подтверждённому занятию.")
			}
		}
		return q.record(ctx, current, action, reason, &before, result)
	})
	return result, err
}
func mergeRequired[T any](f Field[T], target *T, name string, fields *[]FieldError) {
	if !f.Set {
		return
	}
	if f.Value == nil {
		*fields = append(*fields, FieldError{name, "Заполните поле."})
		return
	}
	*target = *f.Value
}
func mergedInput(before Dog, in PatchInput) (CreateInput, error) {
	v := CreateInput{Nickname: before.Nickname, DateOfBirth: before.DateOfBirth, Identifier: IdentifierInput{before.Identifier.Type.ID, before.Identifier.Number, before.Identifier.Date}, StatusID: before.Status.ID, BreedID: before.Breed.ID, CoatColorID: before.CoatColor.ID, SexID: before.Sex.ID, HeightCM: before.HeightCM, WeightKG: before.WeightKG, OwnerIDs: before.OwnerIDs}
	fields := make([]FieldError, 0)
	mergeRequired(in.Nickname, &v.Nickname, "nickname", &fields)
	mergeRequired(in.DateOfBirth, &v.DateOfBirth, "date_of_birth", &fields)
	mergeRequired(in.Identifier, &v.Identifier, "identifier", &fields)
	mergeRequired(in.StatusID, &v.StatusID, "status_id", &fields)
	mergeRequired(in.BreedID, &v.BreedID, "breed_id", &fields)
	mergeRequired(in.CoatColorID, &v.CoatColorID, "coat_color_id", &fields)
	mergeRequired(in.SexID, &v.SexID, "sex_id", &fields)
	if in.HeightCM.Set {
		v.HeightCM = in.HeightCM.Value
	}
	if in.WeightKG.Set {
		v.WeightKG = in.WeightKG.Value
	}
	if len(fields) > 0 {
		return v, &ValidationError{fields}
	}
	return v, nil
}
func (s *Service) Patch(ctx context.Context, p auth.Principal, id int32, in PatchInput) (Dog, error) {
	if !(in.Nickname.Set || in.DateOfBirth.Set || in.Identifier.Set || in.StatusID.Set || in.BreedID.Set || in.CoatColorID.Set || in.SexID.Set || in.HeightCM.Set || in.WeightKG.Set) {
		return Dog{}, invalid("fields", "Передайте хотя бы одно изменяемое поле.")
	}
	return s.mutate(ctx, p, id, in.Version, "dog_updated", "", func(ctx context.Context, q *repository, before Dog) error {
		merged, err := mergedInput(before, in)
		if err != nil {
			return err
		}
		if err := validateCreate(&merged, s.now()); err != nil {
			return err
		}
		if s.dates != nil && merged.DateOfBirth != before.DateOfBirth {
			exists, err := s.dates.RecordsBefore(ctx, q.tx, id, merged.DateOfBirth)
			if err != nil {
				return ErrUnavailable
			}
			if exists {
				return invalid("date_of_birth", "Дата рождения не может быть позже действующих ветеринарных записей.")
			}
		}
		if err := q.update(ctx, id, merged); err != nil {
			return err
		}
		if err := s.validateRelations(ctx, q, id); err != nil {
			return err
		}
		children, err := q.children(ctx, id)
		if err != nil {
			return err
		}
		for _, child := range children {
			if err := s.validateRelations(ctx, q, child); err != nil {
				return err
			}
		}
		return nil
	})
}
func (s *Service) SetOwners(ctx context.Context, p auth.Principal, id int32, in OwnersInput) (Dog, error) {
	return s.mutate(ctx, p, id, in.Version, "owners_updated", "", func(ctx context.Context, q *repository, _ Dog) error {
		if err := s.validateOwnerReferences(ctx, q.tx, in.OwnerIDs); err != nil {
			return err
		}
		return q.owners(ctx, id, in.OwnerIDs)
	})
}
func normalizeParent(p *ParentInput, field string) error {
	if p == nil {
		return nil
	}
	if p.DogID != nil {
		if *p.DogID < 1 || p.External != nil {
			return invalid(field, "Выберите карточку либо внешние сведения.")
		}
		return nil
	}
	if p.External == nil {
		return invalid(field, "Выберите собаку из базы или укажите кличку и номер родословной.")
	}
	e := p.External
	e.Nickname = strings.TrimSpace(e.Nickname)
	e.PedigreeNumber = strings.TrimSpace(e.PedigreeNumber)
	e.Issuer = strings.TrimSpace(e.Issuer)
	if e.Nickname == "" && e.PedigreeNumber == "" {
		return invalid(field, "Укажите кличку или номер родословной.")
	}
	if !validText(e.Nickname, 100) || !validText(e.PedigreeNumber, 100) || !validText(e.Issuer, 150) {
		return invalid(field, "Кличка и номер — не больше 100 символов, организация — не больше 150.")
	}
	return nil
}
func (s *Service) SetPedigree(ctx context.Context, p auth.Principal, id int32, in PedigreeInput) (Dog, error) {
	in.Number = strings.TrimSpace(in.Number)
	in.Issuer = strings.TrimSpace(in.Issuer)
	var fields []FieldError
	if !validText(in.Number, 100) {
		fields = append(fields, FieldError{"number", "Номер родословной — не больше 100 символов."})
	}
	if !validText(in.Issuer, 150) {
		fields = append(fields, FieldError{"issuer", "Организация — не больше 150 символов."})
	}
	if len(fields) == 0 && (in.Number == "") != (in.Issuer == "") {
		if in.Number == "" {
			fields = append(fields, FieldError{"number", "Укажите номер родословной или очистите организацию."})
		} else {
			fields = append(fields, FieldError{"issuer", "Укажите организацию, выдавшую родословную."})
		}
	}
	if len(fields) > 0 {
		return Dog{}, &ValidationError{fields}
	}
	if err := normalizeParent(in.Mother, "mother"); err != nil {
		return Dog{}, err
	}
	if err := normalizeParent(in.Father, "father"); err != nil {
		return Dog{}, err
	}
	return s.mutate(ctx, p, id, in.Version, "pedigree_updated", "", func(ctx context.Context, q *repository, _ Dog) error {
		for _, parent := range []struct {
			field string
			input *ParentInput
		}{{"mother", in.Mother}, {"father", in.Father}} {
			if parent.input != nil && parent.input.DogID != nil {
				if *parent.input.DogID == id {
					return invalid(parent.field, "Собака не может быть собственным родителем.")
				}
				if _, err := q.relative(ctx, *parent.input.DogID); errors.Is(err, ErrNotFound) {
					return invalid(parent.field, "Карточка не найдена. Выберите собаку заново.")
				} else if err != nil {
					return err
				}
			}
		}
		if in.Mother != nil && in.Father != nil && in.Mother.DogID != nil && in.Father.DogID != nil && *in.Mother.DogID == *in.Father.DogID {
			return invalid("father", "Мать и отец должны быть разными собаками.")
		}
		if err := q.savePedigree(ctx, id, in); err != nil {
			return err
		}
		if err := q.cycle(ctx, id); err != nil {
			return err
		}
		return s.validateRelations(ctx, q, id)
	})
}
func (s *Service) validateRelations(ctx context.Context, q *repository, id int32) error {
	d, err := q.card(ctx, id)
	if err != nil {
		return err
	}
	for _, entry := range []struct {
		field, sex, rule, born string
		parent                 *Parent
	}{{"mother", "Сука", "Мать должна быть сукой", "родилась", d.Pedigree.Mother}, {"father", "Кобель", "Отец должен быть кобелем", "родился", d.Pedigree.Father}} {
		if entry.parent == nil || entry.parent.Dog == nil {
			continue
		}
		r := entry.parent.Dog
		if r.Sex.Name != entry.sex {
			return invalid(entry.field, entry.rule+": выберите другую собаку.")
		}
		if r.DateOfBirth >= d.DateOfBirth {
			return invalid(entry.field, fmt.Sprintf("%s — %s %s, не раньше этой собаки (%s). Родитель должен быть старше.", r.Nickname, entry.born, ruDate(r.DateOfBirth), ruDate(d.DateOfBirth)))
		}
	}
	for _, title := range d.Titles {
		if title.AwardedOn != nil && *title.AwardedOn < d.DateOfBirth {
			return invalid("date_of_birth", "Дата рождения не может быть позже даты присвоенного титула.")
		}
	}
	return nil
}
func validateTitle(date *string, birth, basis string, now time.Time) error {
	if !validText(basis, 1000) {
		return invalid("basis", "Основание — не больше 1000 символов.")
	}
	if date != nil && (!dateValid(*date, now) || *date < birth) {
		return invalid("awarded_on", "Дата присвоения должна быть не раньше рождения и не в будущем.")
	}
	return nil
}
func reasonValid(reason string) error {
	if reason == "" || !validText(reason, 500) {
		return invalid("reason", "Укажите причину исправления длиной до 500 символов.")
	}
	return nil
}
func (s *Service) AddTitle(ctx context.Context, p auth.Principal, id int32, in TitleInput) (Dog, error) {
	in.Basis = strings.TrimSpace(in.Basis)
	if in.TitleID < 1 {
		return Dog{}, invalid("title_id", "Выберите титул.")
	}
	return s.mutate(ctx, p, id, in.Version, "title_recorded", "", func(ctx context.Context, q *repository, before Dog) error {
		if err := validateTitle(in.AwardedOn, before.DateOfBirth, in.Basis, s.now()); err != nil {
			return err
		}
		return q.addTitle(ctx, id, in)
	})
}
func (s *Service) UpdateTitle(ctx context.Context, p auth.Principal, id, titleID int32, in TitleUpdateInput) (Dog, error) {
	in.Reason = strings.TrimSpace(in.Reason)
	in.Basis = strings.TrimSpace(in.Basis)
	if err := reasonValid(in.Reason); err != nil {
		return Dog{}, err
	}
	return s.mutate(ctx, p, id, in.Version, "title_corrected", in.Reason, func(ctx context.Context, q *repository, before Dog) error {
		if err := validateTitle(in.AwardedOn, before.DateOfBirth, in.Basis, s.now()); err != nil {
			return err
		}
		return q.updateTitle(ctx, id, titleID, in)
	})
}
func (s *Service) CorrectTitle(ctx context.Context, p auth.Principal, id, titleID int32, in CorrectionInput) (Dog, error) {
	in.Reason = strings.TrimSpace(in.Reason)
	if err := reasonValid(in.Reason); err != nil {
		return Dog{}, err
	}
	return s.mutate(ctx, p, id, in.Version, "title_record_corrected", in.Reason, func(ctx context.Context, q *repository, _ Dog) error { return q.correctTitle(ctx, id, titleID) })
}
func (s *Service) History(ctx context.Context, p auth.Principal, id int32, after int64, limit int) (HistoryPage, error) {
	if after < 0 || limit < 1 || limit > 100 {
		return HistoryPage{}, invalid("query", "Проверьте параметры страницы истории.")
	}
	var result HistoryPage
	err := s.access.WithAccess(ctx, p, []string{"staff", "leader", "owner"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		ctx = notify.WithSink(ctx, s.notifications)
		if err := s.readAccess(ctx, tx, current, id); err != nil {
			return err
		}
		q := &repository{tx}
		if _, err := q.summary(ctx, id); err != nil {
			return err
		}
		var err error
		result, err = q.history(ctx, id, after, limit)
		return err
	})
	return result, err
}
func (s *Service) Dictionaries(ctx context.Context, p auth.Principal) (Dictionaries, error) {
	var result Dictionaries
	err := s.access.WithAccess(ctx, p, []string{"staff", "leader", "owner"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		ctx = notify.WithSink(ctx, s.notifications)
		if _, err := s.owner(ctx, tx, current); err != nil {
			return err
		}
		var err error
		result, err = (&repository{tx}).dictionaries(ctx)
		return err
	})
	return result, err
}

func (s *Service) SetNotificationSink(sink notify.Sink) { s.notifications = sink }

// ruDate shows a YYYY-MM-DD date the way people read it: DD.MM.YYYY.
func ruDate(date string) string {
	if len(date) != 10 {
		return date
	}
	return date[8:10] + "." + date[5:7] + "." + date[0:4]
}
