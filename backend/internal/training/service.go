package training

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode"
	"unicode/utf8"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/dogs"
	"dogclub.local/backend/internal/events"
	"dogclub.local/backend/internal/members"
	"dogclub.local/backend/internal/veterinary"

	"github.com/jackc/pgx/v5"
)

type Service struct {
	access  *auth.Service
	members *members.Service
	dogs    *dogs.Service
	vet     *veterinary.Service
	events  *events.Service
	now     func() time.Time
}

func NewService(a *auth.Service, m *members.Service, d *dogs.Service, v *veterinary.Service, e *events.Service) *Service {
	return &Service{a, m, d, v, e, time.Now}
}

var readRoles = []string{"staff", "leader", "owner"}

func textOK(s string, max int) bool {
	return utf8.ValidString(s) && utf8.RuneCountInString(s) <= max && !strings.ContainsFunc(s, unicode.IsControl)
}
func correction(c *Correction) error {
	c.Reason = strings.TrimSpace(c.Reason)
	if c.Version < 1 {
		return invalid("version", "Обновите страницу и повторите действие.")
	}
	if c.Reason == "" || !textOK(c.Reason, 500) {
		return invalid("reason", "Укажите причину, не больше 500 символов.")
	}
	return nil
}
func validFilter(f Filter) error {
	if f.After < 0 || f.After > 4611686018427387903 || f.Limit < 1 || f.Limit > 100 || f.DogID < 0 || f.TypeID < 0 || !textOK(f.InstructorProfileID, 200) || !textOK(f.AfterProfile, 200) {
		return invalid("query", "Проверьте параметры фильтра и страницы.")
	}
	if f.From != nil && f.To != nil && f.To.Before(*f.From) {
		return invalid("to", "Дата «по» не может быть раньше даты «с».")
	}
	return nil
}
func domainError(err error) error {
	if err == nil {
		return nil
	}
	for _, v := range []error{dogs.ErrNotFound, members.ErrNotFound, events.ErrNotFound} {
		if errors.Is(err, v) {
			return ErrNotFound
		}
	}
	for _, v := range []error{dogs.ErrUnavailable, members.ErrUnavailable, events.ErrUnavailable, veterinary.ErrUnavailable} {
		if errors.Is(err, v) {
			return ErrUnavailable
		}
	}
	var ev *events.ValidationError
	var vet *veterinary.ValidationError
	// Keep the other module's own explanation: it says what exactly to fix.
	if errors.As(err, &ev) && len(ev.Fields) > 0 {
		return invalid("registration_id", ev.Fields[0].Message)
	}
	if errors.As(err, &vet) && len(vet.Fields) > 0 {
		return invalid("dog_id", vet.Fields[0].Message)
	}
	return err
}
func with[T any](ctx context.Context, s *Service, p auth.Principal, roles []string, fn func(context.Context, *repository, auth.Principal) (T, error)) (T, error) {
	var out T
	err := s.access.WithAccess(ctx, p, roles, func(ctx context.Context, tx pgx.Tx, p auth.Principal) error {
		if p.Profile.Role == "owner" {
			if _, err := s.members.RequireActiveOwner(ctx, tx, p); err != nil {
				return err
			}
		}
		var err error
		out, err = fn(ctx, &repository{tx}, p)
		return domainError(err)
	})
	return out, err
}
func (s *Service) Types(ctx context.Context, p auth.Principal) ([]Type, error) {
	return with(ctx, s, p, []string{"admin", "staff", "leader", "owner"}, func(ctx context.Context, q *repository, _ auth.Principal) ([]Type, error) { return q.types(ctx) })
}
func (s *Service) hydrateGrant(ctx context.Context, q *repository, p auth.Principal, g Instructor) (Instructor, error) {
	target, err := s.access.TrainingProfile(ctx, q.tx, p, g.ProfileID)
	if err != nil {
		return g, err
	}
	g.Available = g.Enabled && target.Active && target.MemberID != nil && *target.MemberID == g.MemberID && len(g.TypeIDs) > 0
	g.Name, err = s.members.TrainingName(ctx, q.tx, p, g.MemberID)
	if p.Profile.Role != "admin" {
		g.Qualification = nil
	}
	return g, err
}
func (s *Service) Instructors(ctx context.Context, p auth.Principal, f Filter) (InstructorPage, error) {
	if err := validFilter(f); err != nil {
		return InstructorPage{}, err
	}
	return with(ctx, s, p, []string{"admin", "staff", "leader"}, func(ctx context.Context, q *repository, p auth.Principal) (InstructorPage, error) {
		out := InstructorPage{Records: []Instructor{}}
		ids, err := q.grantIDs(ctx, f)
		if err != nil {
			return out, err
		}
		if len(ids) > f.Limit {
			ids = ids[:f.Limit]
			next := ids[len(ids)-1]
			out.NextAfter = &next
		}
		for _, id := range ids {
			g, err := q.grant(ctx, id)
			if err != nil {
				return out, err
			}
			g, err = s.hydrateGrant(ctx, q, p, g)
			if err != nil {
				return out, err
			}
			out.Records = append(out.Records, g)
		}
		return out, nil
	})
}
func (s *Service) SetInstructor(ctx context.Context, p auth.Principal, id string, in GrantInput) (Instructor, error) {
	in.Reason = strings.TrimSpace(in.Reason)
	in.Qualification = strings.TrimSpace(in.Qualification)
	if id == "" || !textOK(id, 200) || in.Version < 0 {
		return Instructor{}, invalid("profile_id", "Выберите сотрудника из списка и обновите страницу.")
	}
	if in.Qualification == "" || !textOK(in.Qualification, 1000) {
		return Instructor{}, invalid("qualification", "Укажите основание допуска, не больше 1000 символов.")
	}
	if in.Reason == "" || !textOK(in.Reason, 500) {
		return Instructor{}, invalid("reason", "Укажите причину изменения, не больше 500 символов.")
	}
	if len(in.TypeIDs) > 100 || in.Enabled && len(in.TypeIDs) == 0 {
		return Instructor{}, invalid("type_ids", "Отметьте хотя бы один вид дрессировки.")
	}
	seen := map[int32]bool{}
	for _, id := range in.TypeIDs {
		if id < 1 || seen[id] {
			return Instructor{}, invalid("type_ids", "Выберите виды дрессировки из списка, без повторов.")
		}
		seen[id] = true
	}
	return with(ctx, s, p, []string{"admin"}, func(ctx context.Context, q *repository, p auth.Principal) (Instructor, error) {
		target, err := s.access.TrainingProfile(ctx, q.tx, p, id)
		if err != nil {
			return Instructor{}, err
		}
		if target.MemberID == nil || in.Enabled && !target.Active {
			return Instructor{}, invalid("profile_id", "Нужен действующий профиль сотрудника с привязкой к человеку.")
		}
		var before *Instructor
		old, err := q.grant(ctx, id)
		if err == nil {
			if old.Version != in.Version {
				return Instructor{}, ErrConflict
			}
			old, err = s.hydrateGrant(ctx, q, p, old)
			if err != nil {
				return Instructor{}, err
			}
			before = &old
		} else if !errors.Is(err, ErrNotFound) {
			return Instructor{}, err
		} else if in.Version != 0 {
			return Instructor{}, ErrConflict
		}
		if err = q.saveGrant(ctx, id, target, in); err != nil {
			return Instructor{}, err
		}
		out, err := q.grant(ctx, id)
		if err != nil {
			return out, err
		}
		out, err = s.hydrateGrant(ctx, q, p, out)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, p, &id, nil, nil, "saved", in.Reason, before, out)
	})
}
func (s *Service) grantForWrite(ctx context.Context, q *repository, p auth.Principal, typeID int32) (Instructor, error) {
	if p.User.ClubMemberID == nil {
		return Instructor{}, auth.ErrForbidden
	}
	g, err := q.grant(ctx, p.Profile.ID)
	if errors.Is(err, ErrNotFound) {
		return g, auth.ErrForbidden
	}
	if err != nil {
		return g, err
	}
	if !g.Enabled || g.MemberID != *p.User.ClubMemberID || g.userID != p.User.ID || !slices.Contains(g.TypeIDs, typeID) {
		return g, auth.ErrForbidden
	}
	return g, nil
}
func validateInput(in *Input, birth string, now time.Time) error {
	in.Result = strings.TrimSpace(in.Result)
	in.Timezone = strings.TrimSpace(in.Timezone)
	if in.TypeID < 1 {
		return invalid("type_id", "Выберите вид дрессировки.")
	}
	if in.Result == "" || !textOK(in.Result, 2000) {
		return invalid("result", "Опишите результат занятия, не больше 2000 символов.")
	}
	if in.StartsAt.IsZero() || in.StartsAt.UTC().Year() < 1 {
		return invalid("starts_at", "Укажите дату и время начала.")
	}
	if in.EndsAt.IsZero() || in.EndsAt.UTC().Year() > 9999 {
		return invalid("ends_at", "Укажите дату и время окончания.")
	}
	if in.EndsAt.Before(in.StartsAt) {
		return invalid("ends_at", "Окончание не может быть раньше начала.")
	}
	if in.EndsAt.After(now) {
		return invalid("ends_at", "Записывается только уже проведённое занятие: окончание не может быть в будущем.")
	}
	if in.Timezone == "" || in.Timezone == "Local" || !textOK(in.Timezone, 100) {
		return invalid("timezone", "Выберите часовой пояс из списка.")
	}
	loc, err := time.LoadLocation(in.Timezone)
	if err != nil {
		return invalid("timezone", "Неизвестный часовой пояс.")
	}
	if in.StartsAt.In(loc).Year() < 1 || in.EndsAt.In(loc).Year() > 9999 || in.StartsAt.In(loc).Format(time.DateOnly) < birth {
		return invalid("starts_at", "Занятие не может быть раньше рождения собаки.")
	}
	if (in.EventID == nil) != (in.RegistrationID == nil) || in.EventID != nil && (*in.EventID < 1 || *in.RegistrationID < 1) {
		return invalid("registration_id", "Выберите и мероприятие, и запись собаки на него.")
	}
	return nil
}
func (s *Service) medical(ctx context.Context, q *repository, p auth.Principal, dog int32, start, end time.Time) (MedicalCheck, error) {
	v, err := s.vet.CheckForEvents(ctx, q.tx, p, dog, start.UTC().Format(time.DateOnly), end.UTC().Format(time.DateOnly))
	out := MedicalCheck{CheckedAt: s.now().UTC(), Decision: v.Decision, Reasons: []string{}}
	for _, r := range v.Reasons {
		if !slices.Contains(out.Reasons, r.Code) {
			out.Reasons = append(out.Reasons, r.Code)
		}
	}
	return out, err
}
func (s *Service) source(ctx context.Context, q *repository, p auth.Principal, dog int32, in Input) (*events.TrainingSource, error) {
	if in.EventID == nil {
		return nil, nil
	}
	v, err := s.events.ReadForTraining(ctx, q.tx, p, *in.EventID, *in.RegistrationID, dog)
	if err != nil {
		return nil, err
	}
	if v.Type != "Занятие" || v.EventStatus == "draft" || v.EventStatus == "cancelled" || v.RegistrationStatus == "cancelled" || v.StartsAt == nil || v.EndsAt == nil || !v.ScheduleEnabled || in.StartsAt.Before(*v.StartsAt) || in.EndsAt.After(*v.EndsAt) {
		return nil, invalid("registration_id", "Нужна действующая регистрация этой собаки на занятие; время должно быть внутри мероприятия или слота.")
	}
	return &v, nil
}
func (s *Service) hydrate(ctx context.Context, q *repository, p auth.Principal, x Session) (Session, error) {
	if _, err := s.dogs.ReadForVeterinary(ctx, q.tx, p, x.DogID); err != nil {
		return x, err
	}
	var err error
	x.InstructorName, err = s.members.TrainingName(ctx, q.tx, p, x.InstructorMemberID)
	if err != nil {
		return x, err
	}
	if x.Legacy {
		x.Warnings = append(x.Warnings, "legacy_incomplete")
		return x, nil
	}
	med, err := s.medical(ctx, q, p, x.DogID, *x.StartsAt, *x.EndsAt)
	if err != nil {
		return x, err
	}
	x.CurrentMedical = &med
	if med.Decision != "allowed" {
		x.Warnings = append(x.Warnings, "medical_clearance")
	}
	if x.EventSnapshot != nil {
		current, err := s.events.ReadForTraining(ctx, q.tx, p, *x.EventID, *x.RegistrationID, x.DogID)
		if err != nil {
			return x, err
		}
		saved, _ := json.Marshal(x.EventSnapshot)
		fresh, _ := json.Marshal(current)
		changed := !bytes.Equal(saved, fresh)
		x.SourceChanged = &changed
		if current.RegistrationStatus != "attended" {
			x.Warnings = append(x.Warnings, "attendance_unconfirmed")
		}
		if changed {
			x.Warnings = append(x.Warnings, "event_source_changed")
		}
	}
	return x, nil
}
func (s *Service) Create(ctx context.Context, p auth.Principal, dog int32, in Input) (Session, error) {
	return s.save(ctx, p, dog, 0, 0, "", in)
}
func (s *Service) Update(ctx context.Context, p auth.Principal, dog, id int32, in Update) (Session, error) {
	if err := correction(&in.Correction); err != nil {
		return Session{}, err
	}
	return s.save(ctx, p, dog, id, in.Version, in.Reason, in.Input)
}
func (s *Service) save(ctx context.Context, p auth.Principal, dog, id int32, version int64, reason string, in Input) (Session, error) {
	if dog < 1 || id < 0 {
		return Session{}, invalid("id", "Запись не найдена. Откройте её из списка.")
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, p auth.Principal) (Session, error) {
		animal, err := s.dogs.ReadForVeterinary(ctx, q.tx, p, dog)
		if err != nil {
			return Session{}, err
		}
		// Lab 3 fn_dog_active_check: inactive dogs get no new or corrected sessions.
		if animal.Inactive() {
			return Session{}, invalid("dog_id", fmt.Sprintf("Собака имеет статус «%s»: занятия не добавляются и не исправляются.", animal.Status.Name))
		}
		if err = validateInput(&in, animal.DateOfBirth, s.now()); err != nil {
			return Session{}, err
		}
		grant, err := s.grantForWrite(ctx, q, p, in.TypeID)
		if err != nil {
			return Session{}, err
		}
		var before *Session
		if id != 0 {
			old, err := q.session(ctx, dog, id)
			if err != nil {
				return Session{}, err
			}
			if old.InstructorProfileID == nil || *old.InstructorProfileID != p.Profile.ID || old.authorUserID == nil || *old.authorUserID != p.User.ID {
				return Session{}, auth.ErrForbidden
			}
			if old.Version != version || old.IsVoid {
				return Session{}, ErrConflict
			}
			if !slices.Contains(grant.TypeIDs, old.Type.ID) {
				return Session{}, auth.ErrForbidden
			}
			before = &old
		}
		source, err := s.source(ctx, q, p, dog, in)
		if err != nil {
			return Session{}, err
		}
		medical, err := s.medical(ctx, q, p, dog, in.StartsAt, in.EndsAt)
		if err != nil {
			return Session{}, err
		}
		id, err = q.saveSession(ctx, p, dog, id, version, in, grant, source, medical)
		if err != nil {
			return Session{}, err
		}
		out, err := q.session(ctx, dog, id)
		if err != nil {
			return out, err
		}
		action := "created"
		if before != nil {
			action = "corrected"
		}
		if err = q.record(ctx, p, nil, &dog, &id, action, reason, before, out); err != nil {
			return out, err
		}
		return s.hydrate(ctx, q, p, out)
	})
}
func (s *Service) Get(ctx context.Context, p auth.Principal, dog, id int32) (Session, error) {
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, p auth.Principal) (Session, error) {
		if _, err := s.dogs.ReadForVeterinary(ctx, q.tx, p, dog); err != nil {
			return Session{}, err
		}
		x, err := q.session(ctx, dog, id)
		if err != nil {
			return x, err
		}
		return s.hydrate(ctx, q, p, x)
	})
}
func (s *Service) List(ctx context.Context, p auth.Principal, f Filter) (Page[Session], error) {
	if err := validFilter(f); err != nil {
		return Page[Session]{}, err
	}
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, p auth.Principal) (Page[Session], error) {
		out := Page[Session]{Records: []Session{}}
		var owned []int32
		owner := p.Profile.Role == "owner"
		if owner {
			var err error
			owned, err = s.dogs.BreedingOwnerDogs(ctx, q.tx, p)
			if err != nil {
				return out, err
			}
			if f.DogID != 0 && !slices.Contains(owned, f.DogID) {
				return out, ErrNotFound
			}
		}
		ids, err := q.list(ctx, f, owned, owner)
		if err != nil {
			return out, err
		}
		if len(ids) > f.Limit {
			ids = ids[:f.Limit]
			last := ids[len(ids)-1]
			next := int64(last.ID)*2147483648 + int64(last.DogID)
			out.NextAfter = &next
		}
		for _, k := range ids {
			x, err := q.session(ctx, k.DogID, k.ID)
			if err != nil {
				return out, err
			}
			x, err = s.hydrate(ctx, q, p, x)
			if err != nil {
				return out, err
			}
			out.Records = append(out.Records, x)
		}
		return out, nil
	})
}
func (s *Service) Void(ctx context.Context, p auth.Principal, dog, id int32, in Correction) (Session, error) {
	if err := correction(&in); err != nil {
		return Session{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, p auth.Principal) (Session, error) {
		old, err := q.session(ctx, dog, id)
		if err != nil {
			return Session{}, err
		}
		if old.InstructorProfileID == nil || *old.InstructorProfileID != p.Profile.ID || old.authorUserID == nil || *old.authorUserID != p.User.ID {
			return Session{}, auth.ErrForbidden
		}
		if _, err = s.grantForWrite(ctx, q, p, old.Type.ID); err != nil {
			return Session{}, err
		}
		if old.Version != in.Version || old.IsVoid {
			return Session{}, ErrConflict
		}
		if err = q.void(ctx, dog, id, in.Version); err != nil {
			return Session{}, err
		}
		out, err := q.session(ctx, dog, id)
		if err != nil {
			return out, err
		}
		if err = q.record(ctx, p, nil, &dog, &id, "voided", in.Reason, old, out); err != nil {
			return out, err
		}
		return s.hydrate(ctx, q, p, out)
	})
}
func (s *Service) History(ctx context.Context, p auth.Principal, dog, id int32, f Filter) (Page[Change], error) {
	if err := validFilter(f); err != nil {
		return Page[Change]{}, err
	}
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, p auth.Principal) (Page[Change], error) {
		if _, err := s.dogs.ReadForVeterinary(ctx, q.tx, p, dog); err != nil {
			return Page[Change]{}, err
		}
		if _, err := q.session(ctx, dog, id); err != nil {
			return Page[Change]{}, err
		}
		out, err := q.history(ctx, nil, &dog, &id, f)
		if p.Profile.Role == "owner" {
			for i := range out.Records {
				out.Records[i].Before = json.RawMessage("null")
				out.Records[i].After = json.RawMessage("null")
				out.Records[i].Reason = ""
			}
		}
		return out, err
	})
}
func (s *Service) InstructorHistory(ctx context.Context, p auth.Principal, id string, f Filter) (Page[Change], error) {
	if err := validFilter(f); err != nil {
		return Page[Change]{}, err
	}
	return with(ctx, s, p, []string{"admin"}, func(ctx context.Context, q *repository, _ auth.Principal) (Page[Change], error) {
		if _, err := q.grant(ctx, id); err != nil {
			return Page[Change]{}, err
		}
		return q.history(ctx, &id, nil, nil, f)
	})
}
