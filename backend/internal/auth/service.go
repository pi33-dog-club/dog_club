package auth

import (
	"context"
	"errors"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type Options struct {
	JWTKey    []byte
	Issuer    string
	Audience  string
	IOTimeout time.Duration
}

type Service struct {
	repo      *Repository
	mail      Mailer
	tokens    tokens
	passwords *passwords
	timeout   time.Duration
	now       func() time.Time
}

func NewService(repo *Repository, mailer Mailer, options Options) (*Service, error) {
	if len(options.JWTKey) < 32 || options.Issuer == "" || options.Audience == "" || options.IOTimeout <= 0 || mailer == nil {
		return nil, ErrInvalidInput
	}
	return &Service{repo: repo, mail: mailer, tokens: tokens{key: append([]byte(nil), options.JWTKey...), issuer: options.Issuer, audience: options.Audience}, passwords: newPasswords(), timeout: options.IOTimeout, now: time.Now}, nil
}

func (s *Service) scope(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, s.timeout)
}

var loginPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,63}$`)

func validRole(role string) bool {
	switch role {
	case "admin", "staff", "veterinarian", "expert", "owner", "leader":
		return true
	}
	return false
}
func normalizeInvite(in InviteInput) (InviteInput, error) {
	in.Login = strings.ToLower(strings.TrimSpace(in.Login))
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	address, err := mail.ParseAddress(in.Email)
	var fields []FieldError
	if !loginPattern.MatchString(in.Login) {
		fields = append(fields, FieldError{"login", "Логин: от 3 до 64 символов — строчные латинские буквы, цифры, точка, дефис или подчёркивание; начинается с буквы или цифры."})
	}
	if len(in.Email) > 254 || err != nil || address.Address != in.Email || strings.ContainsAny(in.Email, "\r\n") {
		fields = append(fields, FieldError{"email", "Укажите email в виде name@example.ru, не больше 254 символов."})
	}
	if !validRole(in.Role) {
		fields = append(fields, FieldError{"role", "Выберите профиль из списка."})
	}
	if in.ClubMemberID != nil && *in.ClubMemberID <= 0 {
		fields = append(fields, FieldError{"club_member_id", "Укажите номер карточки — целое число от 1."})
	}
	if len(fields) > 0 {
		return in, &InputError{fields}
	}
	return in, nil
}

// Authenticate checks account/session state on every request. Disabled profiles
// can still list/switch their own profiles; business routes call RequireProfile.
func (s *Service) Authenticate(ctx context.Context, encoded string) (Principal, error) {
	c, err := s.tokens.parse(encoded, s.now())
	if err != nil {
		return Principal{}, err
	}
	ctx, cancel := s.scope(ctx)
	defer cancel()
	p, err := s.repo.read().principal(ctx, c.SessionID, c.Subject, s.now())
	if err != nil {
		return Principal{}, err
	}
	if p.Version != c.SessionVersion || p.Profile.ID != c.ProfileID {
		return Principal{}, ErrUnauthenticated
	}
	p.ProfileValid = p.Profile.Enabled && p.Profile.Version == c.ProfileVersion
	return p, nil
}

func RequireProfile(p Principal, roles ...string) error {
	if !p.ProfileValid {
		return ErrForbidden
	}
	for _, role := range roles {
		if p.Profile.Role == role {
			return nil
		}
	}
	return ErrForbidden
}

// Recheck inside the mutation transaction; an earlier middleware check alone
// must not authorize a write after concurrent revocation or profile switching.
func (s *Service) authorize(ctx context.Context, q *queries, p Principal, admin bool) (Principal, error) {
	current, err := q.principal(ctx, p.SessionID, p.User.ID, s.now())
	if err != nil {
		return Principal{}, err
	}
	if current.Version != p.Version || current.Profile.ID != p.Profile.ID {
		return Principal{}, ErrUnauthenticated
	}
	current.ProfileValid = p.ProfileValid && current.Profile.Enabled && current.Profile.Version == p.Profile.Version
	if admin {
		if err := RequireProfile(current, "admin"); err != nil {
			return Principal{}, err
		}
	}
	return current, nil
}

func (s *Service) credentials(p Principal, refresh string) (Credentials, error) {
	access, err := s.tokens.issue(p, s.now())
	if err != nil {
		return Credentials{}, err
	}
	return Credentials{AccessToken: access, TokenType: "Bearer", ExpiresIn: int64(accessLifetime / time.Second), User: p.User, Profile: p.Profile, Refresh: refresh, RefreshUntil: p.ExpiresAt}, nil
}

func (s *Service) Invite(ctx context.Context, actor Principal, in InviteInput) (Invitation, error) {
	return s.invite(ctx, &actor, in, false)
}
func (s *Service) Bootstrap(ctx context.Context, login, email string) (Invitation, error) {
	return s.invite(ctx, nil, InviteInput{Login: login, Email: email, Role: "admin"}, true)
}

func (s *Service) invite(ctx context.Context, actor *Principal, in InviteInput, bootstrap bool) (Invitation, error) {
	in, err := normalizeInvite(in)
	if err != nil {
		return Invitation{}, err
	}
	ctx, cancel := s.scope(ctx)
	defer cancel()
	var invite Invitation
	secret := newSecret()
	err = s.repo.transaction(ctx, func(q *queries) error {
		if bootstrap {
			exists, err := q.hasAdminProfile(ctx)
			if err != nil {
				return err
			}
			if exists {
				u, err := q.userByLogin(ctx, in.Login)
				if err != nil {
					return ErrConflict
				}
				profiles, err := q.profiles(ctx, u.ID)
				if err != nil {
					return err
				}
				if u.Status != "invited" || u.Email != in.Email || len(profiles) != 1 || profiles[0].Role != "admin" {
					return ErrConflict
				}
				invite, err = q.addInvitation(ctx, u.ID, secret, s.now())
				if err != nil {
					return err
				}
				return q.event(ctx, nil, u.ID, "bootstrap_invitation_resent")
			}
		} else {
			if _, err := s.authorize(ctx, q, *actor, true); err != nil {
				return err
			}
		}
		u, err := q.createUser(ctx, newID(), in)
		if err != nil {
			return err
		}
		if _, err = q.addProfile(ctx, u.ID, in.Role); err != nil {
			return err
		}
		invite, err = q.addInvitation(ctx, u.ID, secret, s.now())
		if err != nil {
			return err
		}
		return q.event(ctx, actor, u.ID, "invitation_created")
	})
	if err != nil {
		return Invitation{}, err
	}
	if err := s.sendInvitation(ctx, in.Email, in.Login, secret); err != nil {
		return invite, err
	}
	return invite, nil
}

func (s *Service) sendInvitation(ctx context.Context, email, login, secret string) error {
	body := "Вас пригласили в систему «Клуб собаководства».\nЛогин: " + login + "\nКод активации: " + secret + "\nСрок действия: 48 часов.\nПодтвердите приглашение и задайте свой пароль. Если вы не ожидали приглашения, обратитесь в клуб.\n"
	if err := s.mail.Send(ctx, email, "Приглашение в клуб собаководства", body); err != nil {
		return ErrMail
	}
	return nil
}

func (s *Service) ResendInvitation(ctx context.Context, actor Principal, id string) (Invitation, error) {
	ctx, cancel := s.scope(ctx)
	defer cancel()
	var invite Invitation
	var u User
	secret := newSecret()
	err := s.repo.transaction(ctx, func(q *queries) error {
		if _, err := s.authorize(ctx, q, actor, true); err != nil {
			return err
		}
		old, user, err := q.invitation(ctx, id)
		if err != nil {
			return err
		}
		u = user
		if u.Status != "invited" {
			return ErrConflict
		}
		invite, err = q.addInvitation(ctx, old.UserID, secret, s.now())
		if err != nil {
			return err
		}
		return q.event(ctx, &actor, u.ID, "invitation_resent")
	})
	if err != nil {
		return Invitation{}, err
	}
	return invite, s.sendInvitation(ctx, u.Email, u.Login, secret)
}

func (s *Service) CancelInvitation(ctx context.Context, actor Principal, id string) error {
	ctx, cancel := s.scope(ctx)
	defer cancel()
	return s.repo.transaction(ctx, func(q *queries) error {
		if _, err := s.authorize(ctx, q, actor, true); err != nil {
			return err
		}
		i, _, err := q.invitation(ctx, id)
		if err != nil {
			return err
		}
		if err := q.revokeInvitations(ctx, i.UserID); err != nil {
			return err
		}
		return q.event(ctx, &actor, i.UserID, "invitation_cancelled")
	})
}

func (s *Service) Activate(ctx context.Context, secret, password string) error {
	if !validSecret(secret) {
		return ErrInvalidToken
	}
	if !validPassword(password) {
		return inputError("password", passwordRule)
	}
	hash, err := s.passwords.hash(ctx, password)
	if err != nil {
		return err
	}
	ctx, cancel := s.scope(ctx)
	defer cancel()
	return s.repo.transaction(ctx, func(q *queries) error {
		id, err := q.activate(ctx, secret, hash, s.now())
		if err != nil {
			return err
		}
		return q.event(ctx, nil, id, "account_activated")
	})
}

func (s *Service) Login(ctx context.Context, login, password, profileID string) (Credentials, error) {
	login = strings.ToLower(strings.TrimSpace(login))
	if len(password) > 1024 || !loginPattern.MatchString(login) {
		return Credentials{}, ErrUnauthenticated
	}
	dbctx, cancel := s.scope(ctx)
	u, err := s.repo.read().userByLogin(dbctx, login)
	cancel()
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Credentials{}, err
	}
	matched, err := s.passwords.verify(ctx, u.passwordHash, password)
	if err != nil {
		return Credentials{}, err
	}
	if !matched || u.Status != "active" {
		dbctx, cancel := s.scope(ctx)
		defer cancel()
		target := ""
		if u.ID != "" {
			target = u.ID
		}
		if err := s.repo.read().event(dbctx, nil, target, "login_failed"); err != nil {
			return Credentials{}, err
		}
		return Credentials{}, ErrUnauthenticated
	}
	ctx, cancel = s.scope(ctx)
	defer cancel()
	var principal Principal
	refresh := newSecret()
	err = s.repo.transaction(ctx, func(q *queries) error {
		current, err := q.user(ctx, u.ID)
		if err != nil {
			return err
		}
		if current.Status != "active" || current.passwordHash != u.passwordHash {
			return ErrUnauthenticated
		}
		profiles, err := q.profiles(ctx, u.ID)
		if err != nil {
			return err
		}
		var chosen Profile
		for _, profile := range profiles {
			if profile.Enabled && (profileID == "" || profile.ID == profileID) {
				chosen = profile
				break
			}
		}
		if chosen.ID == "" {
			return ErrForbidden
		}
		principal, err = q.createSession(ctx, u.ID, chosen.ID, refresh, s.now())
		if err != nil {
			return err
		}
		return q.event(ctx, &principal, u.ID, "login_succeeded")
	})
	if err != nil {
		return Credentials{}, err
	}
	return s.credentials(principal, refresh)
}

func (s *Service) Refresh(ctx context.Context, secret string) (Credentials, error) {
	if !validSecret(secret) {
		return Credentials{}, ErrUnauthenticated
	}
	ctx, cancel := s.scope(ctx)
	defer cancel()
	var p Principal
	var reused bool
	next := newSecret()
	err := s.repo.transaction(ctx, func(q *queries) error {
		sid, uid, used, err := q.refreshSession(ctx, secret)
		if err != nil {
			return err
		}
		if used {
			reused = true
			if err := q.revokeSession(ctx, sid); err != nil {
				return err
			}
			return q.event(ctx, nil, uid, "refresh_reuse_detected")
		}
		p, err = q.principal(ctx, sid, uid, s.now())
		if err != nil {
			return err
		}
		if !p.Profile.Enabled {
			return ErrForbidden
		}
		if err := q.useRefresh(ctx, secret); err != nil {
			return err
		}
		if err := q.addRefresh(ctx, sid, next); err != nil {
			return err
		}
		return q.event(ctx, &p, uid, "session_refreshed")
	})
	if err != nil {
		return Credentials{}, err
	}
	if reused {
		return Credentials{}, ErrUnauthenticated
	}
	return s.credentials(p, next)
}

func (s *Service) Profiles(ctx context.Context, p Principal) ([]Profile, error) {
	ctx, cancel := s.scope(ctx)
	defer cancel()
	return s.repo.read().profiles(ctx, p.User.ID)
}

func (s *Service) SwitchProfile(ctx context.Context, p Principal, id string) (Credentials, error) {
	ctx, cancel := s.scope(ctx)
	defer cancel()
	var current Principal
	err := s.repo.transaction(ctx, func(q *queries) error {
		if _, err := s.authorize(ctx, q, p, false); err != nil {
			return err
		}
		profile, err := q.profile(ctx, p.User.ID, id)
		if errors.Is(err, ErrNotFound) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if !profile.Enabled {
			return ErrForbidden
		}
		if err := q.switchProfile(ctx, p.SessionID, id); err != nil {
			return err
		}
		current, err = q.principal(ctx, p.SessionID, p.User.ID, s.now())
		if err != nil {
			return err
		}
		return q.event(ctx, &current, p.User.ID, "profile_switched")
	})
	if err != nil {
		return Credentials{}, err
	}
	return s.credentials(current, "") // The refresh cookie remains bound to this session.
}

func (s *Service) Logout(ctx context.Context, p Principal) error {
	ctx, cancel := s.scope(ctx)
	defer cancel()
	return s.repo.transaction(ctx, func(q *queries) error {
		if _, err := s.authorize(ctx, q, p, false); err != nil {
			return err
		}
		if err := q.revokeSession(ctx, p.SessionID); err != nil {
			return err
		}
		return q.event(ctx, &p, p.User.ID, "logout")
	})
}

func (s *Service) ForgotPassword(ctx context.Context, login string) error {
	login = strings.ToLower(strings.TrimSpace(login))
	if !loginPattern.MatchString(login) {
		return nil
	}
	ctx, cancel := s.scope(ctx)
	defer cancel()
	var u User
	secret := newSecret()
	err := s.repo.transaction(ctx, func(q *queries) error {
		var err error
		u, err = q.userByLogin(ctx, login)
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if u.Status != "active" {
			return nil
		}
		if err := q.addReset(ctx, u.ID, secret, s.now()); err != nil {
			return err
		}
		return q.event(ctx, nil, u.ID, "password_reset_requested")
	})
	if err != nil {
		return err
	}
	if u.Status == "active" {
		// Public response stays identical for missing/blocked accounts and SMTP
		// failures. Record failure without credentials; a later request can retry.
		if err := s.mail.Send(ctx, u.Email, "Восстановление доступа в клуб собаководства", "Логин: "+u.Login+"\nКод восстановления: "+secret+"\nСрок действия: 30 минут. Если вы не запрашивали восстановление, проигнорируйте письмо.\n"); err != nil {
			// SMTP may have exhausted the I/O deadline. Give the diagnostic a
			// separate bounded context and keep its failure out of the public
			// response, which must not reveal whether this login exists.
			auditCtx, done := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
			defer done()
			_ = s.repo.read().event(auditCtx, nil, u.ID, "password_reset_mail_failed")
		}
	}
	return nil
}

func (s *Service) ResetPassword(ctx context.Context, secret, password string) error {
	if !validSecret(secret) {
		return ErrInvalidToken
	}
	if !validPassword(password) {
		return inputError("password", passwordRule)
	}
	hash, err := s.passwords.hash(ctx, password)
	if err != nil {
		return err
	}
	ctx, cancel := s.scope(ctx)
	defer cancel()
	return s.repo.transaction(ctx, func(q *queries) error {
		id, err := q.resetUser(ctx, secret, s.now())
		if err != nil {
			return err
		}
		if err := q.markResetUsed(ctx, secret, s.now()); err != nil {
			return err
		}
		if err := q.setPassword(ctx, id, hash); err != nil {
			return err
		}
		return q.event(ctx, nil, id, "password_reset")
	})
}

func (s *Service) ChangePassword(ctx context.Context, p Principal, oldPassword, password string) error {
	if !validPassword(password) {
		return inputError("password", passwordRule)
	}
	if len(oldPassword) > 1024 {
		return ErrUnauthenticated
	}
	dbctx, cancel := s.scope(ctx)
	u, err := s.repo.read().user(dbctx, p.User.ID)
	cancel()
	if err != nil {
		return err
	}
	matched, err := s.passwords.verify(ctx, u.passwordHash, oldPassword)
	if err != nil {
		return err
	}
	if !matched {
		return ErrUnauthenticated
	}
	hash, err := s.passwords.hash(ctx, password)
	if err != nil {
		return err
	}
	ctx, cancel = s.scope(ctx)
	defer cancel()
	return s.repo.transaction(ctx, func(q *queries) error {
		if _, err := s.authorize(ctx, q, p, false); err != nil {
			return err
		}
		current, err := q.user(ctx, p.User.ID)
		if err != nil {
			return err
		}
		if current.passwordHash != u.passwordHash {
			return ErrUnauthenticated
		}
		if err := q.setPassword(ctx, p.User.ID, hash); err != nil {
			return err
		}
		return q.event(ctx, &p, p.User.ID, "password_changed")
	})
}

func (s *Service) Users(ctx context.Context, p Principal, after string, limit int) ([]User, error) {
	if err := RequireProfile(p, "admin"); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 100 || len(after) > 64 {
		return nil, ErrInvalidInput
	}
	ctx, cancel := s.scope(ctx)
	defer cancel()
	return s.repo.read().users(ctx, after, limit)
}

// UserProfiles lists every profile of an account, enabled or not, for the administrator.
func (s *Service) UserProfiles(ctx context.Context, p Principal, userID string) ([]Profile, error) {
	if err := RequireProfile(p, "admin"); err != nil {
		return nil, err
	}
	if len(userID) > 64 {
		return nil, ErrInvalidInput
	}
	ctx, cancel := s.scope(ctx)
	defer cancel()
	q := s.repo.read()
	if _, err := q.user(ctx, userID); err != nil {
		return nil, err
	}
	return q.profiles(ctx, userID)
}

// UserInvitation is the pending invitation of an account, so the administrator can resend or cancel it.
func (s *Service) UserInvitation(ctx context.Context, p Principal, userID string) (Invitation, error) {
	if err := RequireProfile(p, "admin"); err != nil {
		return Invitation{}, err
	}
	if len(userID) > 64 {
		return Invitation{}, ErrInvalidInput
	}
	ctx, cancel := s.scope(ctx)
	defer cancel()
	return s.repo.read().pendingInvitation(ctx, userID)
}
func (s *Service) AddProfile(ctx context.Context, p Principal, userID, role string) (Profile, error) {
	if !validRole(role) {
		return Profile{}, ErrInvalidInput
	}
	ctx, cancel := s.scope(ctx)
	defer cancel()
	var profile Profile
	err := s.repo.transaction(ctx, func(q *queries) error {
		if _, err := s.authorize(ctx, q, p, true); err != nil {
			return err
		}
		if _, err := q.user(ctx, userID); err != nil {
			return err
		}
		var err error
		profile, err = q.addProfile(ctx, userID, role)
		if err != nil {
			return err
		}
		return q.event(ctx, &p, userID, "profile_assigned", profile.ID)
	})
	return profile, err
}

func (s *Service) SetProfileEnabled(ctx context.Context, p Principal, userID, profileID string, enabled bool) error {
	ctx, cancel := s.scope(ctx)
	defer cancel()
	return s.repo.transaction(ctx, func(q *queries) error {
		if _, err := s.authorize(ctx, q, p, true); err != nil {
			return err
		}
		if err := q.setProfileEnabled(ctx, userID, profileID, enabled); err != nil {
			return err
		}
		count, err := q.activeAdminCount(ctx)
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrLastAdmin
		}
		event := "profile_disabled"
		if enabled {
			event = "profile_enabled"
		}
		return q.event(ctx, &p, userID, event, profileID)
	})
}

func (s *Service) SetUserBlocked(ctx context.Context, p Principal, userID string, blocked bool) error {
	ctx, cancel := s.scope(ctx)
	defer cancel()
	return s.repo.transaction(ctx, func(q *queries) error {
		if _, err := s.authorize(ctx, q, p, true); err != nil {
			return err
		}
		if err := q.setUserBlocked(ctx, userID, blocked); err != nil {
			return err
		}
		count, err := q.activeAdminCount(ctx)
		if err != nil {
			return err
		}
		if count == 0 {
			return ErrLastAdmin
		}
		event := "account_unblocked"
		if blocked {
			event = "account_blocked"
		}
		return q.event(ctx, &p, userID, event)
	})
}

// WithAccess rechecks current account, session and profile inside the same
// PostgreSQL transaction as the caller's operation. The advisory lock also
// serializes it with revocation, profile switches and membership changes.
// Callbacks must use this transaction and must not perform external I/O.
func (s *Service) WithAccess(ctx context.Context, p Principal, roles []string, fn func(context.Context, pgx.Tx, Principal) error) error {
	ctx, cancel := s.scope(ctx)
	defer cancel()
	return s.repo.transaction(ctx, func(q *queries) error {
		current, err := s.authorize(ctx, q, p, false)
		if err != nil {
			return err
		}
		if err := RequireProfile(current, roles...); err != nil {
			return err
		}
		return fn(ctx, q.db.(pgx.Tx), current)
	})
}

// BindMember assigns the initial identity link. Reassignment/unlinking requires
// a separate workflow; repeating the same link is safe.
func (s *Service) BindMember(ctx context.Context, p Principal, userID string, memberID int32) error {
	if memberID <= 0 {
		return ErrInvalidInput
	}
	return s.WithAccess(ctx, p, []string{"admin"}, func(ctx context.Context, tx pgx.Tx, current Principal) error {
		q := &queries{db: tx}
		user, err := q.user(ctx, userID)
		if err != nil {
			return err
		}
		if user.ClubMemberID != nil {
			if *user.ClubMemberID == memberID {
				return nil
			}
			return ErrConflict
		}
		if err := q.bindMember(ctx, userID, memberID); err != nil {
			return err
		}
		return q.event(ctx, &current, userID, "member_linked")
	})
}
