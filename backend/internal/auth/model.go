// Package auth owns accounts, profiles, sessions and access decisions.
package auth

import (
	"context"
	"errors"
	"time"
)

var (
	ErrUnauthenticated = errors.New("unauthenticated")
	ErrForbidden       = errors.New("forbidden")
	ErrInvalidToken    = errors.New("invalid or expired token")
	ErrConflict        = errors.New("account or profile already exists")
	ErrNotFound        = errors.New("not found")
	ErrUnavailable     = errors.New("authentication storage unavailable")
	ErrMail            = errors.New("mail delivery unavailable")
	ErrLastAdmin       = errors.New("last active administrator cannot be disabled")
	ErrInvalidInput    = errors.New("invalid input")
	ErrBusy            = errors.New("authentication capacity exceeded")
)

type User struct {
	ID           string     `json:"id"`
	Login        string     `json:"login"`
	Email        string     `json:"email"`
	Status       string     `json:"status"`
	ClubMemberID *int32     `json:"club_member_id,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	VerifiedAt   *time.Time `json:"email_verified_at,omitempty"`
	passwordHash string
}

type Profile struct {
	ID      string `json:"id"`
	Role    string `json:"role"`
	Enabled bool   `json:"enabled"`
	Version int64  `json:"-"`
}

type Principal struct {
	User         User      `json:"user"`
	Profile      Profile   `json:"profile"`
	SessionID    string    `json:"-"`
	Version      int64     `json:"-"`
	ExpiresAt    time.Time `json:"-"`
	ProfileValid bool      `json:"-"`
}

type Credentials struct {
	AccessToken  string    `json:"access_token"`
	TokenType    string    `json:"token_type"`
	ExpiresIn    int64     `json:"expires_in"`
	User         User      `json:"user"`
	Profile      Profile   `json:"profile"`
	Refresh      string    `json:"-"`
	RefreshUntil time.Time `json:"-"`
}

type InviteInput struct {
	Login        string `json:"login"`
	Email        string `json:"email"`
	Role         string `json:"role"`
	ClubMemberID *int32 `json:"club_member_id,omitempty"`
}

type Invitation struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

type Mailer interface {
	Send(context.Context, string, string, string) error
}

type metadataKey struct{}

func WithRequestID(ctx context.Context, id string) context.Context {
	if len(id) > 200 {
		id = id[:200]
	}
	return context.WithValue(ctx, metadataKey{}, id)
}

func requestID(ctx context.Context) string {
	id, _ := ctx.Value(metadataKey{}).(string)
	return id
}

// RequestID returns the bounded identifier used by transactional audit records.
func RequestID(ctx context.Context) string { return requestID(ctx) }

// FieldError explains one rejected request field in words a person can act on.
type FieldError struct{ Field, Message string }

// InputError is ErrInvalidInput with per-field explanations.
type InputError struct{ Fields []FieldError }

func (e *InputError) Error() string { return "invalid input" }
func (e *InputError) Unwrap() error { return ErrInvalidInput }

func inputError(field, message string) error {
	return &InputError{[]FieldError{{field, message}}}
}

const passwordRule = "Пароль должен быть не короче 15 символов."
