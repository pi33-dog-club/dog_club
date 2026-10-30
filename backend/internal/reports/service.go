package reports

import (
	"context"
	"time"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/breeding"
	"dogclub.local/backend/internal/dogs"
	"dogclub.local/backend/internal/events"
	"dogclub.local/backend/internal/members"
	"dogclub.local/backend/internal/platform/reporting"

	"github.com/jackc/pgx/v5"
)

type Service struct {
	access   *auth.Service
	members  *members.Service
	dogs     *dogs.Service
	breeding *breeding.Service
	events   *events.Service
	now      func() time.Time
}

func NewService(a *auth.Service, m *members.Service, d *dogs.Service, b *breeding.Service, e *events.Service) *Service {
	return &Service{access: a, members: m, dogs: d, breeding: b, events: e, now: time.Now}
}
func (s *Service) ClubActivity(ctx context.Context, p auth.Principal, period reporting.Period) (Report, error) {
	out := Report{Period: period, Methodology: methodology}
	if !period.Valid() {
		return out, invalid("period", "Укажите обе даты периода; дата «по» не раньше даты «с».")
	}
	err := s.access.WithAccess(ctx, p, []string{"staff", "leader"}, func(ctx context.Context, tx pgx.Tx, p auth.Principal) error {
		m, err := s.members.ClubActivity(ctx, tx, p, period)
		if err != nil {
			return ErrUnavailable
		}
		d, err := s.dogs.ClubActivity(ctx, tx, p, period)
		if err != nil {
			return ErrUnavailable
		}
		b, err := s.breeding.ClubActivity(ctx, tx, p, period)
		if err != nil {
			return ErrUnavailable
		}
		e, err := s.events.ClubActivity(ctx, tx, p, period)
		if err != nil {
			return ErrUnavailable
		}
		out.Activity = Activity{MembersJoined: m.Joined, DogsRegistered: d.Registered,
			EventsCompleted: e.Completed, EventsByType: e.ByType, MatingsPerformed: b.PerformedMatings,
			LittersBorn: b.Litters, PuppiesBorn: b.Puppies}
		out.Current = Current{MemberCards: m.Total, ActiveMembers: m.Active,
			DogCards: d.Total, DogsOnRegister: d.OnRegister}
		out.DataQuality = DataQuality{MembersWithoutDate: m.WithoutMembershipDate,
			DogsWithoutDate: d.WithoutRegistrationDate, MatingsWithoutDate: b.WithoutMatingDate,
			EventsWithoutPeriod: e.WithoutPeriod}
		out.GeneratedAt = s.now().UTC()
		return nil
	})
	return out, err
}

// CheckAccess rechecks revocation after export generation outside the transaction.
func (s *Service) CheckAccess(ctx context.Context, p auth.Principal) error {
	return s.access.WithAccess(ctx, p, []string{"staff", "leader"}, func(context.Context, pgx.Tx, auth.Principal) error { return nil })
}
