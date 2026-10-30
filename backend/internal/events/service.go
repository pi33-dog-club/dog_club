package events

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

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
	members       *members.Service
	dogs          *dogs.Service
	vet           *veterinary.Service
	now           func() time.Time
}

func NewService(a *auth.Service, m *members.Service, d *dogs.Service, v *veterinary.Service) *Service {
	return &Service{access: a, members: m, dogs: d, vet: v, now: time.Now}
}

var readRoles = []string{"staff", "expert", "leader", "owner"}

type scope struct {
	background bool
	p          auth.Principal
	memberID   int32
	dogIDs     []int32
}

func domainError(err error) error {
	if err == nil {
		return nil
	}
	var d *dogs.ValidationError
	var m *members.ValidationError
	var v *veterinary.ValidationError
	fields := []FieldError{}
	switch {
	case errors.As(err, &d):
		for _, f := range d.Fields {
			fields = append(fields, FieldError{f.Field, f.Message})
		}
	case errors.As(err, &m):
		for _, f := range m.Fields {
			fields = append(fields, FieldError{f.Field, f.Message})
		}
	case errors.As(err, &v):
		for _, f := range v.Fields {
			fields = append(fields, FieldError{f.Field, f.Message})
		}
	}
	if len(fields) > 0 {
		return &ValidationError{fields}
	}
	if errors.Is(err, dogs.ErrNotFound) || errors.Is(err, members.ErrNotFound) || errors.Is(err, veterinary.ErrNotFound) {
		return ErrNotFound
	}
	if errors.Is(err, dogs.ErrConflict) || errors.Is(err, members.ErrConflict) || errors.Is(err, veterinary.ErrConflict) {
		return ErrConflict
	}
	if errors.Is(err, dogs.ErrUnavailable) || errors.Is(err, members.ErrUnavailable) || errors.Is(err, veterinary.ErrUnavailable) {
		return ErrUnavailable
	}
	return err
}
func with[T any](ctx context.Context, s *Service, p auth.Principal, roles []string, fn func(context.Context, *repository, scope) (T, error)) (T, error) {
	var out T
	err := s.access.WithAccess(ctx, p, roles, func(ctx context.Context, tx pgx.Tx, p auth.Principal) error {
		ctx = notify.WithSink(ctx, s.notifications)
		access := scope{p: p, dogIDs: []int32{}}
		if p.Profile.Role == "owner" {
			var err error
			access.memberID, err = s.members.RequireActiveOwner(ctx, tx, p)
			if err != nil {
				return domainError(err)
			}
			access.dogIDs, err = s.dogs.EventOwnerDogIDs(ctx, tx, p)
			if err != nil {
				return domainError(err)
			}
		}
		var err error
		out, err = fn(ctx, &repository{tx}, access)
		return domainError(err)
	})
	return out, err
}
func (s *Service) eventAccess(ctx context.Context, q *repository, a scope, id int32) (Event, error) {
	e, err := q.event(ctx, id)
	if err != nil {
		return e, err
	}
	if a.p.Profile.Role == "owner" && e.Status == "draft" {
		return Event{}, ErrNotFound
	}
	if a.p.Profile.Role == "expert" && !slices.Contains(e.ExpertProfileIDs, a.p.Profile.ID) {
		return Event{}, auth.ErrForbidden
	}
	return e, nil
}
func entryAccess(a scope, r Registration) error {
	if a.p.Profile.Role != "owner" {
		return nil
	}
	if r.DogID == nil && r.MemberID == a.memberID || r.DogID != nil && slices.Contains(a.dogIDs, *r.DogID) {
		return nil
	}
	return ErrNotFound
}
func (s *Service) hydrate(ctx context.Context, q *repository, a scope, e Event, r Registration) (Registration, error) {
	if err := entryAccess(a, r); err != nil {
		return Registration{}, err
	}
	if a.p.Profile.Role != "owner" || r.MemberID == a.memberID {
		person, err := s.members.EventParticipant(ctx, q.tx, a.p, r.MemberID)
		if err != nil {
			return r, err
		}
		r.Participant = &person
	}
	if r.DogID != nil {
		dog, err := s.dogs.ReadForEvents(ctx, q.tx, a.p, *r.DogID)
		if err != nil {
			return r, err
		}
		r.Dog = &dog
	}
	check, err := s.check(ctx, q, a, e, r)
	if err != nil {
		return r, err
	}
	r.Eligibility = &check
	return r, nil
}
func (s *Service) Event(ctx context.Context, p auth.Principal, id int32) (Event, error) {
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, a scope) (Event, error) { return s.eventAccess(ctx, q, a, id) })
}
func (s *Service) Events(ctx context.Context, p auth.Principal, f Filter) (Page[Event], error) {
	if err := pageValid(f); err != nil {
		return Page[Event]{}, err
	}
	if f.Status != "" && !slices.Contains([]string{"draft", "open", "closed", "in_progress", "completed", "cancelled"}, f.Status) {
		return Page[Event]{}, invalid("status", "Неизвестное состояние мероприятия.")
	}
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, a scope) (Page[Event], error) {
		out := Page[Event]{Records: []Event{}}
		ids, err := q.listEvents(ctx, a.p, f)
		if err != nil {
			return out, err
		}
		ids, out.NextAfter = trimIDs(ids, f.Limit)
		for _, id := range ids {
			e, err := s.eventAccess(ctx, q, a, int32(id))
			if err != nil {
				return out, err
			}
			out.Records = append(out.Records, e)
		}
		return out, nil
	})
}
func trimIDs(ids []int64, limit int) ([]int64, *int64) {
	if len(ids) <= limit {
		return ids, nil
	}
	ids = ids[:limit]
	after := ids[len(ids)-1]
	return ids, &after
}
func (s *Service) Class(ctx context.Context, p auth.Principal, eventID int32, id int64) (Class, error) {
	e, err := s.Event(ctx, p, eventID)
	if err != nil {
		return Class{}, err
	}
	c := classByID(e, &id)
	if c == nil {
		return Class{}, ErrNotFound
	}
	return *c, nil
}
func (s *Service) Schedule(ctx context.Context, p auth.Principal, eventID int32, id int64) (Schedule, error) {
	e, err := s.Event(ctx, p, eventID)
	if err != nil {
		return Schedule{}, err
	}
	slot := slotByID(e, &id)
	if slot == nil {
		return Schedule{}, ErrNotFound
	}
	return *slot, nil
}
func (s *Service) Dictionaries(ctx context.Context, p auth.Principal) (Dictionaries, error) {
	return with(ctx, s, p, readRoles, func(ctx context.Context, q *repository, _ scope) (Dictionaries, error) { return q.dictionaries(ctx) })
}
func (s *Service) ExpertOptions(ctx context.Context, p auth.Principal) ([]ExpertOption, error) {
	return with(ctx, s, p, []string{"staff", "leader"}, func(ctx context.Context, q *repository, a scope) ([]ExpertOption, error) {
		experts, err := s.access.EventExperts(ctx, q.tx, a.p)
		if err != nil {
			return nil, err
		}
		out := []ExpertOption{}
		for _, expert := range experts {
			name := expert.Login
			if expert.MemberID != nil {
				person, err := s.members.EventParticipant(ctx, q.tx, a.p, *expert.MemberID)
				if err != nil {
					return nil, err
				}
				name = person.FullName
			}
			out = append(out, ExpertOption{expert.ProfileID, name})
		}
		return out, nil
	})
}
func (s *Service) Dogs(ctx context.Context, p auth.Principal, f dogs.Filter) (dogs.Page, error) {
	return with(ctx, s, p, []string{"staff", "leader"}, func(ctx context.Context, q *repository, a scope) (dogs.Page, error) {
		return s.dogs.ListForEvents(ctx, q.tx, a.p, f)
	})
}
func (s *Service) Venues(ctx context.Context, p auth.Principal, f Filter) (Page[Venue], error) {
	if err := pageValid(f); err != nil {
		return Page[Venue]{}, err
	}
	return with(ctx, s, p, []string{"staff", "leader"}, func(ctx context.Context, q *repository, _ scope) (Page[Venue], error) {
		out := Page[Venue]{Records: []Venue{}}
		ids, err := q.listVenues(ctx, f)
		if err != nil {
			return out, err
		}
		ids, out.NextAfter = trimIDs(ids, f.Limit)
		for _, id := range ids {
			v, err := q.venue(ctx, id)
			if err != nil {
				return out, err
			}
			out.Records = append(out.Records, v)
		}
		return out, nil
	})
}
func (s *Service) Venue(ctx context.Context, p auth.Principal, id int64) (Venue, error) {
	return with(ctx, s, p, []string{"staff", "leader"}, func(ctx context.Context, q *repository, _ scope) (Venue, error) { return q.venue(ctx, id) })
}
func (s *Service) CreateVenue(ctx context.Context, p auth.Principal, in VenueInput) (Venue, error) {
	if err := validateVenue(&in); err != nil {
		return Venue{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, a scope) (Venue, error) {
		id, err := q.saveVenue(ctx, 0, in)
		if err != nil {
			return Venue{}, err
		}
		out, err := q.venue(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, nil, "venue", id, "created", "", nil, out)
	})
}
func (s *Service) UpdateVenue(ctx context.Context, p auth.Principal, id int64, in VenueUpdate) (Venue, error) {
	if err := validateVenue(&in.VenueInput); err != nil {
		return Venue{}, err
	}
	if err := correction(&in.Correction); err != nil {
		return Venue{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, a scope) (Venue, error) {
		before, err := q.venue(ctx, id)
		if err != nil {
			return before, err
		}
		if err = version(before.Version, in.Version); err != nil {
			return before, err
		}
		used, err := q.historicVenue(ctx, id)
		if err != nil {
			return before, err
		}
		if used {
			return before, ErrConflict
		}
		if err = q.bump(ctx, "venue", id, in.Version); err != nil {
			return before, err
		}
		if _, err = q.saveVenue(ctx, id, in.VenueInput); err != nil {
			return before, err
		}
		out, err := q.venue(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, nil, "venue", id, "corrected", in.Reason, before, out)
	})
}
func (s *Service) CreateEvent(ctx context.Context, p auth.Principal, in EventInput) (Event, error) {
	if err := validateEvent(&in); err != nil {
		return Event{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, a scope) (Event, error) {
		if _, err := q.venue(ctx, in.VenueID); err != nil {
			return Event{}, err
		}
		id, err := q.saveEvent(ctx, 0, in)
		if err != nil {
			return Event{}, err
		}
		out, err := q.event(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, &id, "event", int64(id), "created", "", nil, out)
	})
}
func (s *Service) UpdateEvent(ctx context.Context, p auth.Principal, id int32, in EventUpdate) (Event, error) {
	if err := validateEvent(&in.EventInput); err != nil {
		return Event{}, err
	}
	if err := correction(&in.Correction); err != nil {
		return Event{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, a scope) (Event, error) {
		before, err := q.event(ctx, id)
		if err != nil {
			return before, err
		}
		if err = version(before.Version, in.Version); err != nil {
			return before, err
		}
		if err = editable(before); err != nil {
			return before, err
		}
		facts, err := q.hasFacts(ctx, id)
		if err != nil {
			return before, err
		}
		if facts {
			return before, ErrConflict
		}
		if _, err = q.venue(ctx, in.VenueID); err != nil {
			return before, err
		}
		if err = q.bump(ctx, "event", int64(id), in.Version); err != nil {
			return before, err
		}
		if _, err = q.saveEvent(ctx, id, in.EventInput); err != nil {
			return before, err
		}
		out, err := q.event(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, &id, "event", int64(id), "corrected", in.Reason, before, out)
	})
}
func configured(e Event) error {
	if e.StartsAt == nil || e.EndsAt == nil || e.Timezone == nil || e.Audience == nil || e.Venue == nil {
		return invalid("event", "Сначала заполните данные мероприятия: даты, часовой пояс, участников и площадку.")
	}
	in := EventInput{e.Name, e.Description, e.Type.ID, e.Venue.ID, *e.StartsAt, *e.EndsAt, *e.Timezone, *e.Audience, e.UsesClasses}
	if err := validateEvent(&in); err != nil {
		return err
	}
	if e.UsesClasses {
		found := false
		for _, c := range e.Classes {
			if c.Enabled {
				found = true
			}
		}
		if !found {
			return invalid("classes", "Добавьте хотя бы один действующий класс.")
		}
	}
	return nil
}
func (s *Service) SetState(ctx context.Context, p auth.Principal, id int32, in StateInput) (Event, error) {
	if err := correction(&in.Correction); err != nil {
		return Event{}, err
	}
	transitions := map[string][]string{"draft": {"open", "cancelled"}, "open": {"closed", "cancelled"}, "closed": {"open", "in_progress", "cancelled"}, "in_progress": {"completed", "cancelled"}}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, a scope) (Event, error) {
		before, err := q.event(ctx, id)
		if err != nil {
			return before, err
		}
		if err = version(before.Version, in.Version); err != nil {
			return before, err
		}
		if !slices.Contains(transitions[before.Status], in.Status) {
			return before, ErrConflict
		}
		if in.Status != "cancelled" {
			if err = configured(before); err != nil {
				return before, err
			}
		}
		if in.Status == "in_progress" && before.StartsAt.After(s.now()) {
			return before, invalid("starts_at", "Мероприятие ещё не началось.")
		}
		if err = q.bump(ctx, "event", int64(id), in.Version); err != nil {
			return before, err
		}
		if err = q.state(ctx, id, in.Status); err != nil {
			return before, err
		}
		out, err := q.event(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, &id, "event", int64(id), "state_changed", in.Reason, before, out)
	})
}
func (s *Service) SetExperts(ctx context.Context, p auth.Principal, id int32, in ExpertsInput) (Event, error) {
	if err := correction(&in.Correction); err != nil {
		return Event{}, err
	}
	if len(in.ProfileIDs) > 100 {
		return Event{}, invalid("profile_ids", "Назначьте не более 100 экспертов.")
	}
	seen := map[string]bool{}
	for _, id := range in.ProfileIDs {
		if id == "" || len(id) > 100 || seen[id] {
			return Event{}, invalid("profile_ids", "Укажите разные существующие профили экспертов.")
		}
		seen[id] = true
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, a scope) (Event, error) {
		before, err := q.event(ctx, id)
		if err != nil {
			return before, err
		}
		if err = version(before.Version, in.Version); err != nil {
			return before, err
		}
		if before.Status == "cancelled" {
			return before, ErrConflict
		}
		for _, profile := range in.ProfileIDs {
			if err = s.access.ValidateEventExpert(ctx, q.tx, a.p, profile); errors.Is(err, auth.ErrInvalidInput) {
				return before, invalid("profile_ids", "Выберите включённые профили экспертов активных аккаунтов.")
			} else if err != nil {
				return before, err
			}
		}
		if err = q.bump(ctx, "event", int64(id), in.Version); err != nil {
			return before, err
		}
		if err = q.experts(ctx, id, in.ProfileIDs); err != nil {
			return before, err
		}
		out, err := q.event(ctx, id)
		if err != nil {
			return out, err
		}
		return out, q.record(ctx, a.p, &id, "event", int64(id), "experts_changed", in.Reason, before, out)
	})
}
func (s *Service) SaveClass(ctx context.Context, p auth.Principal, eventID int32, id int64, in ClassCommand) (Class, error) {
	if err := validateClass(&in.ClassInput); err != nil {
		return Class{}, err
	}
	if err := correction(&in.Correction); err != nil {
		return Class{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, a scope) (Class, error) {
		e, err := q.event(ctx, eventID)
		if err != nil {
			return Class{}, err
		}
		if err = editable(e); err != nil {
			return Class{}, err
		}
		facts, err := q.componentFacts(ctx, eventID, "class", id)
		if err != nil {
			return Class{}, err
		}
		if facts {
			return Class{}, ErrConflict
		}
		var before *Class
		if id == 0 {
			if err = version(e.Version, in.Version); err != nil {
				return Class{}, err
			}
		} else {
			before = classByID(e, &id)
			if before == nil {
				return Class{}, ErrNotFound
			}
			if err = version(before.Version, in.Version); err != nil {
				return Class{}, err
			}
			if err = q.bump(ctx, "class", id, in.Version); err != nil {
				return Class{}, err
			}
		}
		if err = q.bump(ctx, "event", int64(eventID), e.Version); err != nil {
			return Class{}, err
		}
		id, err = q.saveClass(ctx, eventID, id, in.ClassInput)
		if err != nil {
			return Class{}, err
		}
		next, err := q.event(ctx, eventID)
		if err != nil {
			return Class{}, err
		}
		out := classByID(next, &id)
		if out == nil {
			return Class{}, ErrUnavailable
		}
		return *out, q.record(ctx, a.p, &eventID, "class", id, "saved", in.Reason, before, *out)
	})
}
func (s *Service) SaveSchedule(ctx context.Context, p auth.Principal, eventID int32, id int64, in ScheduleCommand) (Schedule, error) {
	in.Name = strings.TrimSpace(in.Name)
	var fields []FieldError
	if in.Name == "" {
		fields = append(fields, FieldError{"name", "Укажите название пункта расписания."})
	} else if !textOK(in.Name, 150) {
		fields = append(fields, tooLong("name", 150))
	}
	if in.StartsAt.IsZero() {
		fields = append(fields, FieldError{"starts_at", "Укажите дату и время начала."})
	}
	if in.EndsAt.IsZero() {
		fields = append(fields, FieldError{"ends_at", "Укажите дату и время окончания."})
	} else if !in.StartsAt.IsZero() && !validPeriod(in.StartsAt, in.EndsAt) {
		fields = append(fields, FieldError{"ends_at", "Окончание не может быть раньше начала."})
	}
	if err := fail(fields); err != nil {
		return Schedule{}, err
	}
	if err := correction(&in.Correction); err != nil {
		return Schedule{}, err
	}
	return with(ctx, s, p, []string{"staff"}, func(ctx context.Context, q *repository, a scope) (Schedule, error) {
		e, err := q.event(ctx, eventID)
		if err != nil {
			return Schedule{}, err
		}
		if err = editable(e); err != nil {
			return Schedule{}, err
		}
		if e.StartsAt == nil || e.EndsAt == nil || in.StartsAt.Before(*e.StartsAt) || in.EndsAt.After(*e.EndsAt) {
			return Schedule{}, invalid("starts_at", "Время выступления должно быть внутри периода мероприятия.")
		}
		if in.ClassID != nil && classByID(e, in.ClassID) == nil {
			return Schedule{}, invalid("class_id", "Выберите класс этого мероприятия.")
		}
		// Keep recorded attendance stable while allowing unused slots to move.
		facts, err := q.componentFacts(ctx, eventID, "schedule", id)
		if err != nil {
			return Schedule{}, err
		}
		if facts {
			return Schedule{}, ErrConflict
		}
		var before *Schedule
		if id == 0 {
			if err = version(e.Version, in.Version); err != nil {
				return Schedule{}, err
			}
		} else {
			before = slotByID(e, &id)
			if before == nil {
				return Schedule{}, ErrNotFound
			}
			if err = version(before.Version, in.Version); err != nil {
				return Schedule{}, err
			}
			if err = q.bump(ctx, "schedule", id, in.Version); err != nil {
				return Schedule{}, err
			}
		}
		if err = q.bump(ctx, "event", int64(eventID), e.Version); err != nil {
			return Schedule{}, err
		}
		id, err = q.saveSchedule(ctx, eventID, id, in.ScheduleInput)
		if err != nil {
			return Schedule{}, err
		}
		next, err := q.event(ctx, eventID)
		if err != nil {
			return Schedule{}, err
		}
		out := slotByID(next, &id)
		if out == nil {
			return Schedule{}, ErrUnavailable
		}
		return *out, q.record(ctx, a.p, &eventID, "schedule", id, "saved", in.Reason, before, *out)
	})
}

func (s *Service) SetNotificationSink(sink notify.Sink) { s.notifications = sink }
