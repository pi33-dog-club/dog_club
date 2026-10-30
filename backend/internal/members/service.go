package members

import (
	"context"
	"net/mail"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"dogclub.local/backend/internal/auth"
	"github.com/jackc/pgx/v5"
)

type Service struct {
	access *auth.Service
	now    func() time.Time
}

func NewService(access *auth.Service) *Service { return &Service{access: access, now: time.Now} }
func invalid(field, message string) error {
	return &ValidationError{Fields: []FieldError{{Field: field, Message: message}}}
}
func validText(value string, max int) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(value) <= max && !strings.ContainsFunc(value, unicode.IsControl)
}
func validateCard(in *CreateInput, now time.Time) error {
	in.FullName = strings.TrimSpace(in.FullName)
	fields := make([]FieldError, 0)
	if in.FullName == "" || !validText(in.FullName, 150) {
		fields = append(fields, FieldError{"full_name", "Укажите ФИО длиной до 150 символов."})
	}
	if in.MembershipStatusID <= 0 {
		fields = append(fields, FieldError{"membership_status_id", "Укажите статус членства."})
	}
	var birth, joined time.Time
	today := now.UTC().Format(time.DateOnly)
	for _, item := range []struct {
		field  string
		value  *string
		target *time.Time
	}{
		{"date_of_birth", in.DateOfBirth, &birth}, {"membership_date", in.MembershipDate, &joined},
	} {
		if item.value == nil {
			continue
		}
		date, err := time.Parse(time.DateOnly, *item.value)
		if err != nil || date.Year() < 1 || *item.value > today {
			fields = append(fields, FieldError{item.field, "Укажите существующую дату YYYY-MM-DD, не позднее текущей даты UTC."})
			continue
		}
		if item.field == "date_of_birth" && *item.value < "1900-01-01" {
			fields = append(fields, FieldError{item.field, "Дата рождения должна быть не ранее 1900-01-01."})
			continue
		}
		*item.target = date
	}
	if !birth.IsZero() && !joined.IsZero() && birth.After(joined) {
		fields = append(fields, FieldError{"membership_date", "Дата вступления не может быть раньше даты рождения."})
	}
	if len(fields) > 0 {
		return &ValidationError{Fields: fields}
	}
	return nil
}
func phoneDigits(value string) string {
	var out strings.Builder
	for _, r := range value {
		if r >= '0' && r <= '9' {
			out.WriteRune(r)
			continue
		}
		if !strings.ContainsRune(" +()-.", r) {
			return ""
		}
	}
	return out.String()
}

// Status is a domain restriction on owner operations. It does not revoke the
// account or change its other profiles. Current dictionaries are read-only;
// the named active status is resolved from data, never from its numeric seed ID.
func ownerAccess(ctx context.Context, q *repository, p auth.Principal) error {
	if p.Profile.Role != "owner" {
		return nil
	}
	if p.User.ClubMemberID == nil {
		return auth.ErrForbidden
	}
	m, err := q.member(ctx, *p.User.ClubMemberID)
	if err != nil {
		return err
	}
	if m.MembershipStatus.Name != "Активный" {
		return auth.ErrForbidden
	}
	return nil
}

// RequireActiveOwner provides the membership policy to other domain modules.
// Call it inside auth.WithAccess using the supplied transaction and principal;
// it must not open a nested transaction or expose the member's personal data.
func (s *Service) RequireActiveOwner(ctx context.Context, tx pgx.Tx, p auth.Principal) (int32, error) {
	if err := auth.RequireProfile(p, "owner"); err != nil {
		return 0, err
	}
	if err := ownerAccess(ctx, &repository{tx}, p); err != nil {
		return 0, err
	}
	return *p.User.ClubMemberID, nil
}

// ValidateReferences checks member IDs for a trusted domain transaction without
// returning names, contacts or account data. Membership need not be active to
// remain recorded as an owner; active membership gates owner access instead.
func (s *Service) ValidateReferences(ctx context.Context, tx pgx.Tx, ids []int32) error {
	for _, id := range ids {
		if id < 1 {
			return invalid("owner_ids", "Укажите существующие карточки владельцев.")
		}
		if err := (&repository{tx}).memberExists(ctx, id); err != nil {
			return err
		}
	}
	return nil
}
func memberForRead(ctx context.Context, q *repository, p auth.Principal, id int32) (Member, error) {
	if err := ownerAccess(ctx, q, p); err != nil {
		return Member{}, err
	}
	if id == 0 {
		if p.User.ClubMemberID == nil {
			return Member{}, auth.ErrForbidden
		}
		id = *p.User.ClubMemberID
	}
	if p.Profile.Role == "owner" && id != *p.User.ClubMemberID {
		return Member{}, ErrNotFound
	}
	return q.member(ctx, id)
}
func (s *Service) Get(ctx context.Context, p auth.Principal, id int32) (Member, error) {
	var result Member
	err := s.access.WithAccess(ctx, p, []string{"staff", "leader", "owner"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		var err error
		result, err = memberForRead(ctx, &repository{tx}, current, id)
		return err
	})
	return result, err
}
func (s *Service) List(ctx context.Context, p auth.Principal, f Filter) (Page, error) {
	f.Query = strings.TrimSpace(f.Query)
	if f.Limit < 1 || f.Limit > 100 || f.After < 0 || f.StatusID < 0 || !validText(f.Query, 254) {
		return Page{}, invalid("query", "Проверьте поиск, статус и параметры страницы.")
	}
	var result Page
	err := s.access.WithAccess(ctx, p, []string{"staff", "leader"}, func(ctx context.Context, tx pgx.Tx, _ auth.Principal) error {
		var err error
		result, err = (&repository{tx}).list(ctx, f)
		return err
	})
	return result, err
}
func (s *Service) Create(ctx context.Context, p auth.Principal, in CreateInput) (Member, error) {
	if err := validateCard(&in, s.now()); err != nil {
		return Member{}, err
	}
	var result Member
	err := s.access.WithAccess(ctx, p, []string{"staff"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		q := &repository{tx}
		id, err := q.create(ctx, in)
		if err != nil {
			return err
		}
		result, err = q.member(ctx, id)
		if err != nil {
			return err
		}
		return q.record(ctx, current, "member_created", nil, result)
	})
	return result, err
}
func (s *Service) mutate(ctx context.Context, p auth.Principal, id int32, version int64, action string, fn func(context.Context, *repository, Member) error) (Member, error) {
	if version < 1 {
		return Member{}, invalid("version", "Укажите текущую версию карточки.")
	}
	var result Member
	err := s.access.WithAccess(ctx, p, []string{"staff"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		q := &repository{tx}
		before, err := q.member(ctx, id)
		if err != nil {
			return err
		}
		if err := q.bump(ctx, id, version); err != nil {
			return err
		}
		if err := fn(ctx, q, before); err != nil {
			return err
		}
		result, err = q.member(ctx, id)
		if err != nil {
			return err
		}
		return q.record(ctx, current, action, &before, result)
	})
	return result, err
}
func (s *Service) Patch(ctx context.Context, p auth.Principal, id int32, in PatchInput) (Member, error) {
	if in.FullName == nil && !in.DateOfBirth.Set && !in.MembershipDate.Set && in.MembershipStatusID == nil {
		return Member{}, invalid("fields", "Передайте хотя бы одно изменяемое поле.")
	}
	return s.mutate(ctx, p, id, in.Version, "member_updated", func(ctx context.Context, q *repository, before Member) error {
		merged := CreateInput{FullName: before.FullName, DateOfBirth: before.DateOfBirth, MembershipDate: before.MembershipDate, MembershipStatusID: before.MembershipStatus.ID}
		if in.FullName != nil {
			merged.FullName = *in.FullName
		}
		if in.DateOfBirth.Set {
			merged.DateOfBirth = in.DateOfBirth.Value
		}
		if in.MembershipDate.Set {
			merged.MembershipDate = in.MembershipDate.Value
		}
		if in.MembershipStatusID != nil {
			merged.MembershipStatusID = *in.MembershipStatusID
		}
		if err := validateCard(&merged, s.now()); err != nil {
			return err
		}
		if in.FullName != nil {
			in.FullName = &merged.FullName
		}
		return q.patch(ctx, id, in)
	})
}
func (s *Service) SaveContact(ctx context.Context, p auth.Principal, memberID, id int32, in ContactInput) (Member, error) {
	return s.mutate(ctx, p, memberID, in.Version, "contact_saved", func(ctx context.Context, q *repository, _ Member) error {
		kind, err := q.contactType(ctx, in.TypeID)
		if err != nil {
			return err
		}
		in.Value = strings.TrimSpace(in.Value)
		if in.Value == "" || !validText(in.Value, 254) {
			return invalid("value", "Укажите контакт длиной до 254 символов.")
		}
		switch kind {
		case "Email":
			in.Value = strings.ToLower(in.Value)
			address, err := mail.ParseAddress(in.Value)
			if err != nil || address.Address != in.Value || len(in.Value) > 254 {
				return invalid("value", "Укажите email без имени получателя.")
			}
		case "Телефон":
			digits := phoneDigits(in.Value)
			if len(digits) < 7 || len(digits) > 15 || len(in.Value) > 50 {
				return invalid("value", "Укажите телефон с 7–15 цифрами; допустимы пробелы, +, скобки, точка и дефис.")
			}
		default:
			return invalid("type_id", "Этот тип контакта пока не поддерживается.")
		}
		return q.saveContact(ctx, memberID, id, in)
	})
}
func (s *Service) DeleteContact(ctx context.Context, p auth.Principal, memberID, id int32, version int64) (Member, error) {
	return s.mutate(ctx, p, memberID, version, "contact_deleted", func(ctx context.Context, q *repository, _ Member) error { return q.deleteContact(ctx, memberID, id) })
}
func (s *Service) SaveAddress(ctx context.Context, p auth.Principal, memberID, id int32, in AddressInput) (Member, error) {
	in.Locality = strings.TrimSpace(in.Locality)
	in.Street = strings.TrimSpace(in.Street)
	in.BuildingNumber = strings.TrimSpace(in.BuildingNumber)
	in.ApartmentNumber = strings.TrimSpace(in.ApartmentNumber)
	if in.TypeID < 1 || in.Locality == "" || !validText(in.Locality, 100) || !validText(in.Street, 100) || !validText(in.BuildingNumber, 20) || !validText(in.ApartmentNumber, 20) {
		return Member{}, invalid("address", "Укажите тип и населённый пункт; пределы: населённый пункт/улица — 100, дом/квартира — 20 символов.")
	}
	return s.mutate(ctx, p, memberID, in.Version, "address_saved", func(ctx context.Context, q *repository, _ Member) error { return q.saveAddress(ctx, memberID, id, in) })
}
func (s *Service) DeleteAddress(ctx context.Context, p auth.Principal, memberID, id int32, version int64) (Member, error) {
	return s.mutate(ctx, p, memberID, version, "address_deleted", func(ctx context.Context, q *repository, _ Member) error { return q.deleteAddress(ctx, memberID, id) })
}
func (s *Service) History(ctx context.Context, p auth.Principal, id int32, after int64, limit int) (HistoryPage, error) {
	if after < 0 || limit < 1 || limit > 100 {
		return HistoryPage{}, invalid("query", "Проверьте параметры страницы истории.")
	}
	var result HistoryPage
	err := s.access.WithAccess(ctx, p, []string{"staff", "leader", "owner"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		q := &repository{tx}
		m, err := memberForRead(ctx, q, current, id)
		if err != nil {
			return err
		}
		result, err = q.history(ctx, m.ID, after, limit)
		return err
	})
	return result, err
}
func (s *Service) Dictionaries(ctx context.Context, p auth.Principal) (Dictionaries, error) {
	var result Dictionaries
	err := s.access.WithAccess(ctx, p, []string{"staff", "leader", "owner"}, func(ctx context.Context, tx pgx.Tx, current auth.Principal) error {
		q := &repository{tx}
		if err := ownerAccess(ctx, q, current); err != nil {
			return err
		}
		var err error
		result, err = q.dictionaries(ctx)
		return err
	})
	return result, err
}
