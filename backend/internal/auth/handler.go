package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"dogclub.local/backend/internal/platform/httpapi"
	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
)

const refreshCookie = "dogclub_refresh"
const cookiePath = "/api/v1/auth"

type Handler struct {
	service *Service
	secure  bool
	limit   *limiter
}
type principalKey struct{}

func NewHandler(service *Service, secure bool) *Handler {
	return &Handler{service: service, secure: secure, limit: &limiter{entries: make(map[string]window), now: time.Now}}
}

func (h *Handler) Register(router chi.Router) {
	router.Route("/api/v1", h.RegisterRoutes)
}

func (h *Handler) RegisterRoutes(router chi.Router) {
	router.Group(func(r chi.Router) {
		r.Use(httpapi.Protect)
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Cache-Control", "no-store")
				ctx := WithRequestID(r.Context(), chimiddleware.GetReqID(r.Context()))
				next.ServeHTTP(w, r.WithContext(ctx))
			})
		})
		r.Post("/auth/login", h.publicLimit(10, time.Minute, h.login))
		r.Post("/auth/activate", h.publicLimit(10, time.Minute, h.activate))
		r.Post("/auth/refresh", h.publicLimit(60, time.Minute, h.refresh))
		r.Post("/auth/forgot-password", h.publicLimit(5, 15*time.Minute, h.forgot))
		r.Post("/auth/reset-password", h.publicLimit(10, time.Minute, h.reset))
		r.Group(func(r chi.Router) {
			r.Use(h.RequireAccount)
			r.Get("/auth/me", h.me)
			r.Get("/auth/profiles", h.profiles)
			r.Post("/auth/switch-profile", h.switchProfile)
			r.Post("/auth/logout", h.logout)
			r.Post("/auth/change-password", h.publicLimit(10, time.Minute, h.changePassword))
			r.Group(func(r chi.Router) {
				r.Use(h.requireAdmin)
				r.Get("/users", h.users)
				r.Patch("/users/{userID}", h.blockUser)
				r.Put("/users/{userID}/member", h.bindMember)
				r.Get("/users/{userID}/profiles", h.userProfiles)
				r.Get("/users/{userID}/invitation", h.userInvitation)
				r.Post("/users/{userID}/profiles", h.addProfile)
				r.Patch("/users/{userID}/profiles/{profileID}", h.profileState)
				r.Post("/invitations", h.publicLimit(20, time.Minute, h.invite))
				r.Post("/invitations/{invitationID}/resend", h.publicLimit(10, time.Minute, h.resend))
				r.Delete("/invitations/{invitationID}", h.cancelInvitation)
			})
		})
	})
}

func PrincipalFrom(r *http.Request) Principal { return r.Context().Value(principalKey{}).(Principal) }

func (h *Handler) RequireAccount(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Fields(r.Header.Get("Authorization"))
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			writeAuthError(w, r, ErrUnauthenticated)
			return
		}
		p, err := h.service.Authenticate(r.Context(), parts[1])
		if err != nil {
			writeAuthError(w, r, err)
			return
		}
		ctx := WithRequestID(r.Context(), chimiddleware.GetReqID(r.Context()))
		next.ServeHTTP(w, r.WithContext(context.WithValue(ctx, principalKey{}, p)))
	})
}

func (h *Handler) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := RequireProfile(PrincipalFrom(r), "admin"); err != nil {
			writeAuthError(w, r, err)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	if problem := httpapi.DecodeJSONLimit(w, r, dst, 16<<10); problem != nil {
		httpapi.WriteProblem(w, r, problem)
		return false
	}
	return true
}
func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Login     string `json:"login"`
		Password  string `json:"password"`
		ProfileID string `json:"profile_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	credentials, err := h.service.Login(r.Context(), in.Login, in.Password, in.ProfileID)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	h.writeCredentials(w, credentials)
}
func (h *Handler) activate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := h.service.Activate(r.Context(), in.Token, in.Password); err != nil {
		writeAuthError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (h *Handler) refresh(w http.ResponseWriter, r *http.Request) {
	cookies := r.CookiesNamed(refreshCookie)
	if len(cookies) != 1 {
		h.clearCookie(w)
		writeAuthError(w, r, ErrUnauthenticated)
		return
	}
	credentials, err := h.service.Refresh(r.Context(), cookies[0].Value)
	if err != nil {
		if errors.Is(err, ErrUnauthenticated) {
			h.clearCookie(w)
		}
		writeAuthError(w, r, err)
		return
	}
	h.writeCredentials(w, credentials)
}
func (h *Handler) writeCredentials(w http.ResponseWriter, c Credentials) {
	if c.Refresh != "" {
		maxAge := int(time.Until(c.RefreshUntil).Seconds())
		if maxAge < 1 {
			maxAge = 1
		}
		http.SetCookie(w, &http.Cookie{Name: refreshCookie, Value: c.Refresh, Path: cookiePath, HttpOnly: true, Secure: h.secure, SameSite: http.SameSiteStrictMode, Expires: c.RefreshUntil, MaxAge: maxAge})
	}
	httpapi.WriteJSON(w, http.StatusOK, c)
}
func (h *Handler) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: refreshCookie, Path: cookiePath, MaxAge: -1, Expires: time.Unix(1, 0), HttpOnly: true, Secure: h.secure, SameSite: http.SameSiteStrictMode})
}
func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	httpapi.WriteJSON(w, 200, PrincipalFrom(r))
}
func (h *Handler) profiles(w http.ResponseWriter, r *http.Request) {
	profiles, err := h.service.Profiles(r.Context(), PrincipalFrom(r))
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, struct {
		Profiles []Profile `json:"profiles"`
	}{profiles})
}
func (h *Handler) switchProfile(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ProfileID string `json:"profile_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := h.service.SwitchProfile(r.Context(), PrincipalFrom(r), in.ProfileID)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	h.writeCredentials(w, c)
}
func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if err := h.service.Logout(r.Context(), PrincipalFrom(r)); err != nil {
		writeAuthError(w, r, err)
		return
	}
	h.clearCookie(w)
	w.WriteHeader(204)
}
func (h *Handler) forgot(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Login string `json:"login"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := h.service.ForgotPassword(r.Context(), in.Login); err != nil {
		writeAuthError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 202, struct {
		Message string `json:"message"`
	}{"Если восстановление доступно для этой учётной записи, инструкции будут отправлены на её email."})
}
func (h *Handler) reset(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := h.service.ResetPassword(r.Context(), in.Token, in.Password); err != nil {
		writeAuthError(w, r, err)
		return
	}
	h.clearCookie(w)
	w.WriteHeader(204)
}
func (h *Handler) changePassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"current_password"`
		Password        string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := h.service.ChangePassword(r.Context(), PrincipalFrom(r), in.CurrentPassword, in.Password); err != nil {
		writeAuthError(w, r, err)
		return
	}
	h.clearCookie(w)
	w.WriteHeader(204)
}
func (h *Handler) invite(w http.ResponseWriter, r *http.Request) {
	var in InviteInput
	if !decode(w, r, &in) {
		return
	}
	i, err := h.service.Invite(r.Context(), PrincipalFrom(r), in)
	if errors.Is(err, ErrMail) {
		w.Header().Set("Location", "/api/v1/invitations/"+i.ID+"/resend")
	}
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 201, i)
}
func (h *Handler) resend(w http.ResponseWriter, r *http.Request) {
	i, err := h.service.ResendInvitation(r.Context(), PrincipalFrom(r), chi.URLParam(r, "invitationID"))
	if errors.Is(err, ErrMail) {
		w.Header().Set("Location", "/api/v1/invitations/"+i.ID+"/resend")
	}
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, i)
}
func (h *Handler) cancelInvitation(w http.ResponseWriter, r *http.Request) {
	if err := h.service.CancelInvitation(r.Context(), PrincipalFrom(r), chi.URLParam(r, "invitationID")); err != nil {
		writeAuthError(w, r, err)
		return
	}
	w.WriteHeader(204)
}
func (h *Handler) users(w http.ResponseWriter, r *http.Request) {
	limit, err := parseLimit(r.URL.Query().Get("limit"))
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	users, err := h.service.Users(r.Context(), PrincipalFrom(r), r.URL.Query().Get("after"), limit)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, struct {
		Users []User `json:"users"`
	}{users})
}
func (h *Handler) blockUser(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Blocked *bool `json:"blocked"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Blocked == nil {
		writeAuthError(w, r, ErrInvalidInput)
		return
	}
	if err := h.service.SetUserBlocked(r.Context(), PrincipalFrom(r), chi.URLParam(r, "userID"), *in.Blocked); err != nil {
		writeAuthError(w, r, err)
		return
	}
	w.WriteHeader(204)
}
func (h *Handler) userProfiles(w http.ResponseWriter, r *http.Request) {
	profiles, err := h.service.UserProfiles(r.Context(), PrincipalFrom(r), chi.URLParam(r, "userID"))
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, struct {
		Profiles []Profile `json:"profiles"`
	}{profiles})
}
func (h *Handler) userInvitation(w http.ResponseWriter, r *http.Request) {
	i, err := h.service.UserInvitation(r.Context(), PrincipalFrom(r), chi.URLParam(r, "userID"))
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 200, i)
}
func (h *Handler) addProfile(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Role string `json:"role"`
	}
	if !decode(w, r, &in) {
		return
	}
	p, err := h.service.AddProfile(r.Context(), PrincipalFrom(r), chi.URLParam(r, "userID"), in.Role)
	if err != nil {
		writeAuthError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, 201, p)
}
func (h *Handler) profileState(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Enabled *bool `json:"enabled"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Enabled == nil {
		writeAuthError(w, r, ErrInvalidInput)
		return
	}
	if err := h.service.SetProfileEnabled(r.Context(), PrincipalFrom(r), chi.URLParam(r, "userID"), chi.URLParam(r, "profileID"), *in.Enabled); err != nil {
		writeAuthError(w, r, err)
		return
	}
	w.WriteHeader(204)
}

func writeAuthError(w http.ResponseWriter, r *http.Request, err error) {
	status, code, detail := 503, "auth_unavailable", "Сервис авторизации временно недоступен."
	switch {
	case errors.Is(err, ErrUnauthenticated):
		status, code, detail = 401, "unauthenticated", "Войдите в систему или повторите вход."
		w.Header().Set("WWW-Authenticate", `Bearer realm="dogclub"`)
	case errors.Is(err, ErrForbidden):
		status, code, detail = 403, "forbidden", "Для этого действия недостаточно прав или профиль отключён."
	case errors.Is(err, ErrInvalidToken):
		status, code, detail = 400, "invalid_token", "Код недействителен или срок его действия истёк."
	case errors.Is(err, ErrConflict):
		status, code, detail = 409, "account_conflict", "Учётная запись или профиль уже существуют либо операция недоступна в текущем состоянии."
	case errors.Is(err, ErrNotFound):
		status, code, detail = 404, "not_found", "Запись не найдена."
	case errors.Is(err, ErrLastAdmin):
		status, code, detail = 409, "last_admin", "Нельзя отключить последнего действующего администратора."
	case errors.Is(err, ErrInvalidInput):
		var input *InputError
		if errors.As(err, &input) {
			fields := make([]httpapi.FieldError, 0, len(input.Fields))
			for _, f := range input.Fields {
				fields = append(fields, httpapi.FieldError{Field: f.Field, Code: "invalid", Message: f.Message})
			}
			httpapi.WriteProblem(w, r, httpapi.ValidationProblem(fields...))
			return
		}
		status, code, detail = 422, "validation_failed", "Проверьте введённые данные."
	case errors.Is(err, ErrMail):
		status, code, detail = 503, "mail_unavailable", "Письмо не удалось отправить. Повторите отправку приглашения позже из карточки пользователя."
	case errors.Is(err, ErrBusy):
		status, code, detail = 429, "rate_limited", "Слишком много попыток. Повторите позже."
		if w.Header().Get("Retry-After") == "" {
			w.Header().Set("Retry-After", "60")
		}
	}
	httpapi.WriteProblem(w, r, httpapi.NewProblem(status, code, detail))
}

// Bounded, process-local endpoint/IP throttling. Forwarded headers are not
// trusted. Entries contain hashes rather than raw client addresses or logins.
type window struct {
	start time.Time
	count int
}
type limiter struct {
	mu      sync.Mutex
	entries map[string]window
	now     func() time.Time
}

func (l *limiter) allow(key string, n int, d time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	for k, v := range l.entries {
		if now.Sub(v.start) >= 15*time.Minute {
			delete(l.entries, k)
		}
	}
	v, exists := l.entries[key]
	if !exists && len(l.entries) >= 4096 {
		return false
	}
	if !exists || now.Sub(v.start) >= d {
		v = window{start: now}
	}
	if v.count >= n {
		return false
	}
	v.count++
	l.entries[key] = v
	return true
}
func (h *Handler) publicLimit(n int, d time.Duration, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		key := sha256.Sum256([]byte(host + "|" + chi.RouteContext(r.Context()).RoutePattern()))
		if !h.limit.allow(hex.EncodeToString(key[:]), n, d) {
			w.Header().Set("Retry-After", strconv.Itoa(int(d/time.Second)))
			writeAuthError(w, r, ErrBusy)
			return
		}
		next(w, r)
	}
}

// WriteError maps auth failures consistently for other HTTP modules.
func WriteError(w http.ResponseWriter, r *http.Request, err error) { writeAuthError(w, r, err) }

func (h *Handler) bindMember(w http.ResponseWriter, r *http.Request) {
	var in struct {
		MemberID int32 `json:"member_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := h.service.BindMember(r.Context(), PrincipalFrom(r), chi.URLParam(r, "userID"), in.MemberID); err != nil {
		writeAuthError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
