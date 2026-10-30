package documents

import (
	"context"

	"dogclub.local/backend/internal/auth"
	"dogclub.local/backend/internal/breeding"
	"dogclub.local/backend/internal/dogs"
	"dogclub.local/backend/internal/events"
	"dogclub.local/backend/internal/members"
	"dogclub.local/backend/internal/veterinary"
)

type sourceSnapshot struct {
	Event        *events.DocumentSource     `json:"event,omitempty"`
	ExpertName   string                     `json:"expert_name,omitempty"`
	Breeding     *breeding.DocumentSource   `json:"breeding,omitempty"`
	Document     Input                      `json:"document"`
	Member       *members.Member            `json:"member"`
	Dogs         []dogs.Summary             `json:"dogs"`
	Dog          *dogs.Dog                  `json:"dog"`
	Recipient    *members.EventParticipant  `json:"recipient"`
	Medical      *veterinary.DocumentSource `json:"medical"`
	Vaccinations []veterinary.Vaccination   `json:"vaccinations"`
}

func (s *Service) source(ctx context.Context, q *repository, p auth.Principal, d Document, in Generate, issuing bool) (sourceSnapshot, error) {
	out := sourceSnapshot{Document: d.Input, Dogs: []dogs.Summary{}, Vaccinations: []veterinary.Vaccination{}}
	if issuing {
		if _, err := s.references(ctx, q, p, d.Input); err != nil {
			return out, err
		}
	}
	if (d.BreedingDecisionID != nil || d.LitterID != nil) && in.Template != "breeding_conclusion" && in.Template != "litter_act" {
		return out, invalid("template", "Выберите соответствующую племенную форму.")
	}
	if d.EventID != nil {
		return s.eventSource(ctx, q, p, d, in, issuing, out)
	}
	switch in.Template {
	case "breeding_conclusion", "litter_act":
		if d.DogID == nil || in.ExaminationID != nil || in.ClearanceID != nil || s.breeding == nil {
			return out, invalid("basis", "Для этой формы выберите только племенное основание.")
		}
		if in.Template == "breeding_conclusion" && (d.TypeName != "Заключение о вязке" || d.BreedingDecisionID == nil) || in.Template == "litter_act" && (d.TypeName != "Акт о регистрации помёта" || d.LitterID == nil) {
			return out, invalid("template", "Форма не соответствует типу и основанию.")
		}
		basis, err := s.breeding.ReadForDocuments(ctx, q.tx, p, *d.DogID, d.BreedingDecisionID, d.LitterID, d.RecipientMemberID != nil, issuing)
		if err != nil {
			return out, domainError(err)
		}
		out.Breeding = &basis
		if basis.Decision != nil {
			expert, err := s.access.DocumentExpert(ctx, q.tx, p, basis.Decision.ActorProfileID)
			if err != nil {
				return out, err
			}
			out.ExpertName = "ФИО не указано"
			if expert.MemberID != nil {
				name, err := s.members.DocumentSignerName(ctx, q.tx, p, *expert.MemberID)
				if err != nil {
					return out, domainError(err)
				}
				out.ExpertName = name
			}
		}

		if d.RecipientMemberID != nil {
			person, err := s.members.DocumentIdentity(ctx, q.tx, p, *d.RecipientMemberID)
			if err != nil {
				return out, domainError(err)
			}
			out.Recipient = &person
		}

	case "member_card":
		if d.MemberID == nil || d.TypeName != "Карточка члена клуба" || in.ExaminationID != nil || in.ClearanceID != nil {
			return out, invalid("template", "Выберите тип карточки члена клуба и человека.")
		}
		m, err := s.members.ReadForDocuments(ctx, q.tx, p, *d.MemberID)
		if err != nil {
			return out, domainError(err)
		}
		out.Member = &m
		var after int64
		for {
			page, err := s.dogs.ListForDocuments(ctx, q.tx, p, *d.MemberID, after)
			if err != nil {
				return out, domainError(err)
			}
			out.Dogs = append(out.Dogs, page.Dogs...)
			if len(out.Dogs) > 1000 {
				return out, invalid("dogs", "Слишком много собак для одной формы.")
			}
			if page.NextAfter == nil {
				break
			}
			after = int64(*page.NextAfter)
		}
	case "dog_card", "veterinary_conclusion", "registration_certificate":
		if d.DogID == nil {
			return out, invalid("dog_id", "Укажите собаку.")
		}
		dog, err := s.dogs.ReadForDocuments(ctx, q.tx, p, *d.DogID)
		if err != nil {
			return out, domainError(err)
		}
		out.Dog = &dog
		if d.RecipientMemberID != nil {
			person, err := s.members.DocumentIdentity(ctx, q.tx, p, *d.RecipientMemberID)
			if err != nil {
				return out, domainError(err)
			}
			out.Recipient = &person
		}
		if in.Template == "registration_certificate" {
			if d.TypeName != "Регистрационное свидетельство" || d.RecipientMemberID == nil || in.ExaminationID != nil || in.ClearanceID != nil {
				return out, invalid("template", "Укажите регистрационное свидетельство и получателя-владельца.")
			}
			if issuing && dog.RegistrationDate == nil {
				return out, invalid("registration_date", "Сначала подтвердите дату регистрации собаки.")
			}
		} else if in.Template == "dog_card" {
			if d.TypeName != "Карточка собаки" || in.ExaminationID != nil || in.ClearanceID != nil {
				return out, invalid("template", "Выберите тип карточки собаки без медицинского основания.")
			}
			out.Vaccinations, err = s.vet.VaccinationsForDocuments(ctx, q.tx, p, *d.DogID)
			if err != nil {
				return out, domainError(err)
			}
		} else {
			if d.TypeName != "Ветеринарная справка" || in.ExaminationID == nil || *in.ExaminationID < 1 || in.ClearanceID != nil && *in.ClearanceID < 1 {
				return out, invalid("examination_id", "Выберите ветеринарную справку и конкретный осмотр.")
			}
			medical, err := s.vet.ReadForDocuments(ctx, q.tx, p, *d.DogID, *in.ExaminationID, in.ClearanceID)
			if err != nil {
				return out, domainError(err)
			}
			if issuing {
				if err := auth.RequireProfile(p, "veterinarian"); err != nil {
					return out, err
				}
				if medical.Examination.Author.UserID == nil || *medical.Examination.Author.UserID != p.User.ID {
					return out, auth.ErrForbidden
				}
				if medical.Examination.IsVoid || medical.Clearance != nil && medical.Clearance.IsVoid {
					return out, invalid("source", "Отменённое основание нельзя использовать для новой формы.")
				}
			}
			out.Medical = &medical
		}
	default:
		return out, invalid("template", "Неизвестная печатная форма.")
	}
	return out, nil
}
