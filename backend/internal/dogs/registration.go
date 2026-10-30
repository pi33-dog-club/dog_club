package dogs

import (
	"context"
	"strings"

	"dogclub.local/backend/internal/auth"
)

type RegistrationInput struct {
	Version int64         `json:"version"`
	Reason  string        `json:"reason"`
	Date    Field[string] `json:"registration_date"`
}

// SetRegistrationDate changes a confirmed club date, never a server audit date.
func (s *Service) SetRegistrationDate(ctx context.Context, p auth.Principal, id int32, in RegistrationInput) (Dog, error) {
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Reason == "" || !validText(in.Reason, 500) {
		return Dog{}, invalid("reason", "Укажите причину подтверждения или исправления даты до 500 символов.")
	}
	if !in.Date.Set {
		return Dog{}, invalid("registration_date", "Укажите дату регистрации.")
	}
	if in.Date.Value != nil && !dateValid(*in.Date.Value, s.now()) {
		return Dog{}, invalid("registration_date", "Дата регистрации не может быть позже сегодняшней.")
	}
	return s.mutate(ctx, p, id, in.Version, "registration_date_confirmed", in.Reason, func(ctx context.Context, q *repository, before Dog) error {
		if in.Date.Value != nil && *in.Date.Value < before.DateOfBirth {
			return invalid("registration_date", "Регистрация не может быть раньше рождения.")
		}
		return q.setRegistrationDate(ctx, id, in.Date.Value)
	})
}
func (q *repository) setRegistrationDate(ctx context.Context, id int32, date *string) error {
	_, err := q.tx.Exec(ctx, `UPDATE dog SET registration_date=$2::date WHERE dog_id=$1`, id, date)
	return storageError(err)
}
