package events

import (
	"context"
	"errors"
	"slices"
	"time"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/dogs"
)

// pedigreeRequired lists the event types where lab 3 requires a pedigree known
// to three generations; seminars, conferences and forums do not.
func pedigreeRequired(eventType string) bool {
	return eventType == "Выставка" || eventType == "Соревнование"
}

func (s *Service) check(ctx context.Context, q *repository, a scope, e Event, r Registration) (Eligibility, error) {
	out := Eligibility{CheckedAt: s.now().UTC(), EventVersion: e.Version, BlockingReasons: []string{}}
	if e.StartsAt == nil || e.EndsAt == nil || e.Timezone == nil || e.Audience == nil {
		out.BlockingReasons = append(out.BlockingReasons, "event_unconfigured")
		return out, nil
	}
	out.StartsAt, out.EndsAt = *e.StartsAt, *e.EndsAt
	loc, err := location(*e.Timezone)
	if err != nil {
		return out, err
	}
	if r.ScheduleID != nil {
		slot := slotByID(e, r.ScheduleID)
		if slot == nil {
			out.BlockingReasons = append(out.BlockingReasons, "schedule_missing")
		} else {
			out.StartsAt, out.EndsAt = slot.StartsAt, slot.EndsAt
			if !slot.Enabled {
				out.BlockingReasons = append(out.BlockingReasons, "schedule_disabled")
			}
			if slot.StartsAt.Before(*e.StartsAt) || slot.EndsAt.After(*e.EndsAt) {
				out.BlockingReasons = append(out.BlockingReasons, "schedule_outside_event")
			}
			if slot.ClassID != nil && !sameID(slot.ClassID, r.ClassID) {
				out.BlockingReasons = append(out.BlockingReasons, "schedule_class_mismatch")
			}
		}
	}
	out.LocalDate = out.StartsAt.In(loc).Format(time.DateOnly)
	// Clinical dates follow the veterinary module’s UTC calendar contract.
	medicalStart := out.StartsAt.UTC().Format(time.DateOnly)
	medicalEnd := out.EndsAt.UTC().Format(time.DateOnly)
	if e.Status == "cancelled" {
		out.BlockingReasons = append(out.BlockingReasons, "event_cancelled")
	}
	if e.Status == "draft" {
		out.BlockingReasons = append(out.BlockingReasons, "event_draft")
	}
	if r.Status == "cancelled" {
		out.BlockingReasons = append(out.BlockingReasons, "registration_cancelled")
	}
	if r.DogID == nil {
		if *e.Audience == "dogs" {
			out.BlockingReasons = append(out.BlockingReasons, "dog_required")
		}
		out.QualificationCurrent = true
		out.context = fingerprint(e, r, out.StartsAt, out.EndsAt, nil, 0)
		return out, nil
	}
	if *e.Audience == "people" {
		out.BlockingReasons = append(out.BlockingReasons, "people_only")
	}
	dog := r.Dog
	if dog == nil {
		var v dogs.EventAnimal
		var err error
		if a.background {
			v, err = s.dogs.NotificationAnimal(ctx, q.tx, *r.DogID)
		} else {
			v, err = s.dogs.ReadForEvents(ctx, q.tx, a.p, *r.DogID)
		}
		if err != nil {
			return out, err
		}
		dog = &v
	}
	out.Dog = dog
	// Lab 3 fn_get_event_admission: inactive dogs are refused for any event type.
	if dog.Inactive() {
		out.BlockingReasons = append(out.BlockingReasons, "dog_inactive")
	}
	if pedigreeRequired(e.Type.Name) && (dog.PedigreeKnown3 == nil || !*dog.PedigreeKnown3) {
		out.BlockingReasons = append(out.BlockingReasons, "pedigree_incomplete")
	}
	if dog.Identifier.Number == "" {
		out.BlockingReasons = append(out.BlockingReasons, "identifier_missing")
	}
	if a.background {
		err = s.dogs.NotificationRepresentative(ctx, q.tx, *r.DogID, r.MemberID)
	} else {
		err = s.dogs.ValidateEventRepresentative(ctx, q.tx, a.p, *r.DogID, r.MemberID)
	}
	if errors.Is(err, dogs.ErrNotFound) {
		out.BlockingReasons = append(out.BlockingReasons, "representative_not_owner")
	} else if err != nil {
		return out, err
	}
	out.Class = classByID(e, r.ClassID)
	if e.UsesClasses && r.ClassID == nil {
		out.BlockingReasons = append(out.BlockingReasons, "class_required")
	}
	if !e.UsesClasses && r.ClassID != nil {
		out.BlockingReasons = append(out.BlockingReasons, "classes_not_used")
	}
	if r.ClassID != nil && out.Class == nil {
		out.BlockingReasons = append(out.BlockingReasons, "class_missing")
	}
	if out.Class != nil && !out.Class.Enabled {
		out.BlockingReasons = append(out.BlockingReasons, "class_disabled")
	}
	allowed, err := ageAllowed(dog.DateOfBirth, out.LocalDate, out.Class)
	if err != nil {
		return out, err
	}
	if !allowed {
		out.BlockingReasons = append(out.BlockingReasons, "age_not_allowed")
	}
	medical, err := s.admissionForNotification(ctx, q, a, r, medicalStart, medicalEnd)
	if err != nil {
		return out, err
	}
	out.Medical = &medical
	if medical.Decision != "allowed" {
		out.BlockingReasons = append(out.BlockingReasons, "medical_clearance")
	}
	out.context = fingerprint(e, r, out.StartsAt, out.EndsAt, out.Class, dog.Version)
	out.QualificationCurrent = out.Class == nil || !out.Class.RequiresExpert
	if out.Class != nil && out.Class.RequiresExpert {
		if r.Qualification == "approved" && r.QualificationContext != nil && *r.QualificationContext == out.context && r.QualifierProfileID != nil {
			assigned, err := q.assigned(ctx, e.ID, *r.QualifierProfileID)
			if err != nil {
				return out, err
			}
			active, err := s.expertForNotification(ctx, q, a, *r.QualifierProfileID)
			if err != nil {
				return out, err
			}
			out.QualificationCurrent = assigned && active
		}
		if !out.QualificationCurrent {
			out.BlockingReasons = append(out.BlockingReasons, "qualification_required")
		}
	}
	return out, nil
}
func (s *Service) validateEntry(ctx context.Context, q *repository, a scope, e Event, in RegistrationInput) error {
	if err := validateRegistration(in); err != nil {
		return err
	}
	if err := s.members.ValidateReferences(ctx, q.tx, []int32{in.MemberID}); err != nil {
		return err
	}
	if e.Audience == nil {
		return invalid("event", "Сначала настройте мероприятие.")
	}
	if in.DogID == nil && *e.Audience == "dogs" {
		return invalid("dog_id", "Для мероприятия требуется собака.")
	}
	if in.DogID != nil && *e.Audience == "people" {
		return invalid("dog_id", "Мероприятие предназначено для людей без собак.")
	}
	if in.DogID != nil {
		if _, err := s.dogs.ReadForEvents(ctx, q.tx, a.p, *in.DogID); err != nil {
			return err
		}
		if err := s.dogs.ValidateEventRepresentative(ctx, q.tx, a.p, *in.DogID, in.MemberID); errors.Is(err, dogs.ErrNotFound) {
			return invalid("member_id", "Представитель должен быть текущим владельцем собаки.")
		} else if err != nil {
			return err
		}
		if e.UsesClasses != (in.ClassID != nil) {
			return invalid("class_id", "Выберите класс, если мероприятие использует классы.")
		}
	}
	if in.ClassID != nil {
		c := classByID(e, in.ClassID)
		if c == nil || !c.Enabled {
			return invalid("class_id", "Выберите действующий класс этого мероприятия.")
		}
	}
	if in.ScheduleID != nil {
		slot := slotByID(e, in.ScheduleID)
		if slot == nil || !slot.Enabled || slot.ClassID != nil && !sameID(slot.ClassID, in.ClassID) {
			return invalid("schedule_id", "Выберите подходящий действующий пункт расписания.")
		}
	}
	return nil
}
func (s *Service) Registration(ctx context.Context, p auth.Principal, eventID int32, id int64) (Registration, error) {
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, a scope) (Registration, error) {
		e, err := s.eventAccess(ctx, q, a, eventID)
		if err != nil {
			return Registration{}, err
		}
		r, err := q.registration(ctx, eventID, id)
		if err != nil {
			return r, err
		}
		return s.hydrate(ctx, q, a, e, r)
	})
}
func (s *Service) Registrations(ctx context.Context, p auth.Principal, eventID int32, f Filter) (Page[Registration], error) {
	if err := pageValid(f); err != nil {
		return Page[Registration]{}, err
	}
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, a scope) (Page[Registration], error) {
		out := Page[Registration]{Records: []Registration{}}
		e, err := s.eventAccess(ctx, q, a, eventID)
		if err != nil {
			return out, err
		}
		ids, err := q.listEntries(ctx, eventID, "registration", f, a.dogIDs, a.memberID, a.p.Profile.Role != "owner")
		if err != nil {
			return out, err
		}
		ids, out.NextAfter = trimIDs(ids, f.Limit)
		for _, id := range ids {
			r, err := q.registration(ctx, eventID, id)
			if err != nil {
				return out, err
			}
			r, err = s.hydrate(ctx, q, a, e, r)
			if err != nil {
				return out, err
			}
			out.Records = append(out.Records, r)
		}
		return out, nil
	})
}
func (s *Service) CreateRegistration(ctx context.Context, p auth.Principal, eventID int32, in RegistrationInput) (Registration, error) {
	if err := validateRegistration(in); err != nil {
		return Registration{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, a scope) (Registration, error) {
		e, err := q.event(ctx, eventID)
		if err != nil {
			return Registration{}, err
		}
		if e.Status != "open" {
			return Registration{}, ErrConflict
		}
		if err = s.validateEntry(ctx, q, a, e, in); err != nil {
			return Registration{}, err
		}
		id, err := q.saveRegistration(ctx, eventID, 0, in)
		if err != nil {
			return Registration{}, err
		}
		out, err := q.registration(ctx, eventID, id)
		if err != nil {
			return out, err
		}
		out, err = s.hydrate(ctx, q, a, e, out)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, &eventID, "registration", id, "created", "", nil, out)
	})
}
func (s *Service) UpdateRegistration(ctx context.Context, p auth.Principal, eventID int32, id int64, in RegistrationUpdate) (Registration, error) {
	if err := validateRegistration(in.RegistrationInput); err != nil {
		return Registration{}, err
	}
	if err := correction(&in.Correction); err != nil {
		return Registration{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, a scope) (Registration, error) {
		e, err := q.event(ctx, eventID)
		if err != nil {
			return Registration{}, err
		}
		if !slices.Contains([]string{"open", "closed", "in_progress"}, e.Status) {
			return Registration{}, ErrConflict
		}
		before, err := q.registration(ctx, eventID, id)
		if err != nil {
			return before, err
		}
		if err = version(before.Version, in.Version); err != nil {
			return before, err
		}
		if before.Status == "attended" {
			return before, ErrConflict
		}
		if err = s.validateEntry(ctx, q, a, e, in.RegistrationInput); err != nil {
			return before, err
		}
		if err = q.bump(ctx, "registration", id, in.Version); err != nil {
			return before, err
		}
		if _, err = q.saveRegistration(ctx, eventID, id, in.RegistrationInput); err != nil {
			return before, err
		}
		out, err := q.registration(ctx, eventID, id)
		if err != nil {
			return out, err
		}
		out, err = s.hydrate(ctx, q, a, e, out)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, &eventID, "registration", id, "corrected", in.Reason, before, out)
	})
}
func (s *Service) Eligibility(ctx context.Context, p auth.Principal, eventID int32, id int64) (Eligibility, error) {
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, a scope) (Eligibility, error) {
		e, err := s.eventAccess(ctx, q, a, eventID)
		if err != nil {
			return Eligibility{}, err
		}
		r, err := q.registration(ctx, eventID, id)
		if err != nil {
			return Eligibility{}, err
		}
		if err = entryAccess(a, r); err != nil {
			return Eligibility{}, err
		}
		return s.check(ctx, q, a, e, r)
	})
}
func (s *Service) Qualify(ctx context.Context, p auth.Principal, eventID int32, id int64, in QualificationInput) (Registration, error) {
	if err := correction(&in.Correction); err != nil {
		return Registration{}, err
	}
	if in.Decision != "approved" && in.Decision != "rejected" {
		return Registration{}, invalid("decision", "Выберите решение: подтвердить или отклонить квалификацию.")
	}
	return with(ctx, s, p, []string{"expert"}, func(ctx context.Context, q *repository, a scope) (Registration, error) {
		e, err := s.eventAccess(ctx, q, a, eventID)
		if err != nil {
			return Registration{}, err
		}
		if err = editable(e); err != nil {
			return Registration{}, err
		}
		before, err := q.registration(ctx, eventID, id)
		if err != nil {
			return before, err
		}
		if err = version(before.Version, in.Version); err != nil {
			return before, err
		}
		if before.Status != "registered" {
			return before, ErrConflict
		}
		check, err := s.check(ctx, q, a, e, before)
		if err != nil {
			return before, err
		}
		if before.DogID == nil || check.Class == nil || !check.Class.RequiresExpert {
			return before, invalid("qualification", "Для этой регистрации отдельное подтверждение не требуется.")
		}
		if in.Decision == "approved" {
			for _, reason := range check.BlockingReasons {
				if reason != "qualification_required" {
					return before, invalid("checks", "Сначала устраните автоматические причины недопуска.")
				}
			}
		}
		if err = q.bump(ctx, "registration", id, in.Version); err != nil {
			return before, err
		}
		if err = q.qualify(ctx, id, a.p, in.Decision, in.Reason, check.context); err != nil {
			return before, err
		}
		out, err := q.registration(ctx, eventID, id)
		if err != nil {
			return out, err
		}
		out, err = s.hydrate(ctx, q, a, e, out)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, &eventID, "registration", id, "qualification_decided", in.Reason, before, out)
	})
}
func (s *Service) registrationAction(ctx context.Context, p auth.Principal, eventID int32, id int64, in Correction, attend bool) (Registration, error) {
	if err := correction(&in); err != nil {
		return Registration{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, a scope) (Registration, error) {
		e, err := q.event(ctx, eventID)
		if err != nil {
			return Registration{}, err
		}
		if err = editable(e); err != nil && (attend || e.Status != "completed") {
			return Registration{}, err
		}
		before, err := q.registration(ctx, eventID, id)
		if err != nil {
			return before, err
		}
		if err = version(before.Version, in.Version); err != nil {
			return before, err
		}
		if before.Status == "cancelled" || attend && before.Status != "registered" {
			return before, ErrConflict
		}
		if !attend && before.Status == "attended" {
			exists, err := q.activeResult(ctx, id)
			if err != nil {
				return before, err
			}
			if exists {
				return before, invalid("result", "Сначала эксперт должен отметить результат ошибочным.")
			}
		}
		status, action := "cancelled", "cancelled"
		var snapshot *Eligibility
		if attend {
			if e.Status != "in_progress" {
				return before, ErrConflict
			}
			check, err := s.check(ctx, q, a, e, before)
			if err != nil {
				return before, err
			}
			if len(check.BlockingReasons) > 0 {
				return before, invalid("checks", "Участник не прошёл проверку допуска.")
			}
			if check.StartsAt.After(s.now()) {
				return before, invalid("starts_at", "Время участия ещё не наступило.")
			}
			status, action = "attended", "attended"
			snapshot = &check
		}
		if err = q.bump(ctx, "registration", id, in.Version); err != nil {
			return before, err
		}
		if err = q.registrationState(ctx, id, status, snapshot); err != nil {
			return before, err
		}
		out, err := q.registration(ctx, eventID, id)
		if err != nil {
			return out, err
		}
		out, err = s.hydrate(ctx, q, a, e, out)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, &eventID, "registration", id, action, in.Reason, before, out)
	})
}
func (s *Service) Attend(ctx context.Context, p auth.Principal, eventID int32, id int64, in Correction) (Registration, error) {
	return s.registrationAction(ctx, p, eventID, id, in, true)
}
func (s *Service) CancelRegistration(ctx context.Context, p auth.Principal, eventID int32, id int64, in Correction) (Registration, error) {
	return s.registrationAction(ctx, p, eventID, id, in, false)
}

func (s *Service) resultAccess(ctx context.Context, q *repository, a scope, eventID, id int32) (Result, error) {
	r, err := q.result(ctx, eventID, id)
	if err != nil {
		return r, err
	}
	if a.p.Profile.Role == "owner" {
		if !slices.Contains(a.dogIDs, r.DogID) {
			return Result{}, ErrNotFound
		}
		r.EntrySnapshot = nil
	}
	return r, nil
}
func (s *Service) Result(ctx context.Context, p auth.Principal, eventID, id int32) (Result, error) {
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, a scope) (Result, error) {
		if _, err := s.eventAccess(ctx, q, a, eventID); err != nil {
			return Result{}, err
		}
		return s.resultAccess(ctx, q, a, eventID, id)
	})
}
func (s *Service) Results(ctx context.Context, p auth.Principal, eventID int32, f Filter) (Page[Result], error) {
	if err := pageValid(f); err != nil {
		return Page[Result]{}, err
	}
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, a scope) (Page[Result], error) {
		out := Page[Result]{Records: []Result{}}
		if _, err := s.eventAccess(ctx, q, a, eventID); err != nil {
			return out, err
		}
		ids, err := q.listEntries(ctx, eventID, "result", f, a.dogIDs, a.memberID, a.p.Profile.Role != "owner")
		if err != nil {
			return out, err
		}
		ids, out.NextAfter = trimIDs(ids, f.Limit)
		for _, id := range ids {
			r, err := s.resultAccess(ctx, q, a, eventID, int32(id))
			if err != nil {
				return out, err
			}
			out.Records = append(out.Records, r)
		}
		return out, nil
	})
}
func (s *Service) CreateResult(ctx context.Context, p auth.Principal, eventID int32, registrationID int64, in ResultCreate) (Result, error) {
	if err := validateResult(&in.ResultInput); err != nil {
		return Result{}, err
	}
	if err := correction(&in.Correction); err != nil {
		return Result{}, err
	}
	return with(ctx, s, p, []string{"expert"}, func(ctx context.Context, q *repository, a scope) (Result, error) {
		e, err := s.eventAccess(ctx, q, a, eventID)
		if err != nil {
			return Result{}, err
		}
		if e.Status != "in_progress" && e.Status != "completed" {
			return Result{}, ErrConflict
		}
		r, err := q.registration(ctx, eventID, registrationID)
		if err != nil {
			return Result{}, err
		}
		if err = version(r.Version, in.Version); err != nil {
			return Result{}, err
		}
		if r.Status != "attended" || r.Attendance == nil {
			return Result{}, invalid("registration", "Сначала зафиксируйте фактическое участие.")
		}
		if r.DogID == nil {
			return Result{}, invalid("dog_id", "Для человека без собаки фиксируется посещение, а не оценка животного.")
		}
		r, err = s.hydrate(ctx, q, a, e, r)
		if err != nil {
			return Result{}, err
		}
		r.Eligibility = nil
		if err = q.bump(ctx, "registration", registrationID, in.Version); err != nil {
			return Result{}, err
		}
		id, err := q.saveResult(ctx, a.p, r, 0, in.ResultInput)
		if err != nil {
			return Result{}, err
		}
		next, err := q.registration(ctx, eventID, registrationID)
		if err != nil {
			return Result{}, err
		}
		if err = q.record(ctx, a.p, &eventID, "registration", registrationID, "result_recorded", in.Reason, r, next); err != nil {
			return Result{}, err
		}
		out, err := q.result(ctx, eventID, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, &eventID, "result", int64(id), "created", in.Reason, nil, out)
	})
}
func (s *Service) UpdateResult(ctx context.Context, p auth.Principal, eventID, id int32, in ResultUpdate) (Result, error) {
	if err := validateResult(&in.ResultInput); err != nil {
		return Result{}, err
	}
	if err := correction(&in.Correction); err != nil {
		return Result{}, err
	}
	return with(ctx, s, p, []string{"expert"}, func(ctx context.Context, q *repository, a scope) (Result, error) {
		e, err := s.eventAccess(ctx, q, a, eventID)
		if err != nil {
			return Result{}, err
		}
		if e.Status == "cancelled" {
			return Result{}, ErrConflict
		}
		before, err := q.result(ctx, eventID, id)
		if err != nil {
			return before, err
		}
		if err = version(before.Version, in.Version); err != nil {
			return before, err
		}
		if before.IsVoid {
			return before, ErrConflict
		}
		if err = q.bump(ctx, "result", int64(id), in.Version); err != nil {
			return before, err
		}
		if _, err = q.saveResult(ctx, a.p, Registration{EventID: eventID}, id, in.ResultInput); err != nil {
			return before, err
		}
		out, err := q.result(ctx, eventID, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, &eventID, "result", int64(id), "corrected", in.Reason, before, out)
	})
}
func (s *Service) VoidResult(ctx context.Context, p auth.Principal, eventID, id int32, in Correction) (Result, error) {
	if err := correction(&in); err != nil {
		return Result{}, err
	}
	return with(ctx, s, p, []string{"expert"}, func(ctx context.Context, q *repository, a scope) (Result, error) {
		e, err := s.eventAccess(ctx, q, a, eventID)
		if err != nil {
			return Result{}, err
		}
		if e.Status == "cancelled" {
			return Result{}, ErrConflict
		}
		before, err := q.result(ctx, eventID, id)
		if err != nil {
			return before, err
		}
		if err = version(before.Version, in.Version); err != nil {
			return before, err
		}
		if before.IsVoid {
			return before, ErrConflict
		}
		if err = q.bump(ctx, "result", int64(id), in.Version); err != nil {
			return before, err
		}
		if err = q.voidResult(ctx, eventID, id); err != nil {
			return before, err
		}
		out, err := q.result(ctx, eventID, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, &eventID, "result", int64(id), "voided", in.Reason, before, out)
	})
}
func (s *Service) History(ctx context.Context, p auth.Principal, eventID int32, entity string, id int64, f Filter) (Page[Change], error) {
	if err := pageValid(f); err != nil {
		return Page[Change]{}, err
	}
	roles := readRoles
	if entity == "venue" {
		roles = []string{"staff", "leader"}
	}
	return with(ctx, s, p, roles, func(ctx context.Context, q *repository, a scope) (Page[Change], error) {
		if entity == "venue" {
			if _, err := q.venue(ctx, id); err != nil {
				return Page[Change]{}, err
			}
		} else {
			if _, err := s.eventAccess(ctx, q, a, eventID); err != nil {
				return Page[Change]{}, err
			}
			switch entity {
			case "event":
				if a.p.Profile.Role == "owner" {
					return Page[Change]{}, auth.ErrForbidden
				}
				id = int64(eventID)
			case "registration":
				r, err := q.registration(ctx, eventID, id)
				if err != nil {
					return Page[Change]{}, err
				}
				if err = entryAccess(a, r); err != nil {
					return Page[Change]{}, err
				}
			case "result":
				if _, err := s.resultAccess(ctx, q, a, eventID, int32(id)); err != nil {
					return Page[Change]{}, err
				}
			default:
				return Page[Change]{}, ErrNotFound
			}
		}
		out, err := q.history(ctx, &eventID, entity, id, f)
		if a.p.Profile.Role == "owner" {
			for i := range out.Records {
				out.Records[i].Before = nil
				out.Records[i].After = nil
			}
		}
		return out, err
	})
}
