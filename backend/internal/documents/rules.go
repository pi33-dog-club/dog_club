package documents

import (
	"bytes"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"dogclub.local/backend/internal/platform/filestore"
)

func category(name string) string {
	switch name {
	case "Заключение о вязке", "Акт о регистрации помёта":
		return "breeding"
	case "Ветеринарный паспорт", "Ветеринарная справка", "Документ о результатах обследования":
		return "medical"
	default:
		return "general"
	}
}
func text(s string, max int) bool {
	return utf8.ValidString(s) && utf8.RuneCountInString(s) <= max && !strings.ContainsFunc(s, unicode.IsControl)
}
func date(s string) bool { t, e := time.Parse(time.DateOnly, s); return e == nil && t.Year() > 0 }
func validate(in *Input, today string) error {
	if in.BreedingDecisionID != nil && in.LitterID != nil {
		return invalid("litter_id", "Выберите одно основание: решение эксперта или помёт.")
	}
	if in.BreedingDecisionID != nil && *in.BreedingDecisionID < 1 {
		return invalid("breeding_decision_id", "Выберите решение эксперта из списка.")
	}
	if in.LitterID != nil && *in.LitterID < 1 {
		return invalid("litter_id", "Выберите помёт из списка.")
	}
	in.Number = strings.TrimSpace(in.Number)
	in.Issuer = strings.TrimSpace(in.Issuer)
	if in.TypeID < 1 {
		return invalid("type_id", "Выберите тип документа.")
	}
	if !text(in.Number, 50) {
		return invalid("number", "Номер — не больше 50 символов.")
	}
	if !text(in.Issuer, 2000) {
		return invalid("issuer", "Не больше 2000 символов.")
	}
	if in.EventID == nil && in.DogID == nil && in.MemberID == nil {
		return invalid("dog_id", "Выберите собаку или члена клуба, к которому относится документ.")
	}
	if in.EventID == nil && in.DogID != nil && in.MemberID != nil {
		return invalid("member_id", "Документ относится либо к собаке, либо к человеку. Выберите что-то одно.")
	}
	for _, v := range []struct {
		field string
		id    *int32
	}{{"dog_id", in.DogID}, {"member_id", in.MemberID}, {"recipient_member_id", in.RecipientMemberID}, {"event_id", in.EventID}, {"event_result_id", in.EventResultID}} {
		if v.id != nil && *v.id < 1 {
			return invalid(v.field, "Выберите значение из списка.")
		}
	}
	for _, v := range []struct {
		field string
		value *string
	}{{"issue_date", in.IssueDate}, {"expires_on", in.ExpiresOn}} {
		if v.value != nil && !date(*v.value) {
			return invalid(v.field, "Укажите существующую дату.")
		}
	}
	// Lab 3 fn_document_dates_check: a document cannot be issued in the future.
	if in.IssueDate != nil && *in.IssueDate > today {
		return invalid("issue_date", "Дата выдачи не может быть в будущем.")
	}
	if in.ExpiresOn != nil && in.IssueDate != nil && *in.ExpiresOn < *in.IssueDate {
		return invalid("expires_on", "Окончание не может быть раньше выдачи.")
	}
	if in.MemberID != nil {
		if in.RecipientMemberID != nil && *in.RecipientMemberID != *in.MemberID {
			return invalid("recipient_member_id", "Для личного документа получатель должен совпадать с человеком.")
		}
		in.RecipientMemberID = in.MemberID
	}
	return nil
}
func correction(c *Correction) error {
	c.Reason = strings.TrimSpace(c.Reason)
	if c.Version < 1 {
		return invalid("version", "Обновите страницу и повторите действие.")
	}
	if c.Reason == "" || !text(c.Reason, 500) {
		return invalid("reason", "Укажите причину, не больше 500 символов.")
	}
	return nil
}
func validFilter(f Filter) error {
	if f.After < 0 || f.Limit < 1 || f.Limit > 100 || f.EventID < 0 || f.TypeID < 0 || f.MemberID < 0 || f.DogID < 0 || !text(f.Number, 50) {
		return invalid("query", "Проверьте параметры фильтра и страницы.")
	}
	for _, d := range []*string{f.From, f.To} {
		if d != nil && !date(*d) {
			return invalid("from", "Укажите существующую дату.")
		}
	}
	if f.From != nil && f.To != nil && *f.To < *f.From {
		return invalid("to", "Дата «по» не может быть раньше даты «с».")
	}
	return nil
}
func validateFile(name, media string, data []byte) error {
	if len(data) == 0 || len(data) > filestore.MaxSize || !text(name, 150) || strings.ContainsAny(name, `/\`) || name == "" || name == "." || name == ".." {
		return invalid("file", "Файл должен быть не больше 10 МБ, а его имя — без символов / и \\.")
	}
	ext := strings.ToLower(filepath.Ext(name))
	switch media {
	case "application/pdf":
		if ext != ".pdf" || !bytes.HasPrefix(data, []byte("%PDF-")) || !bytes.HasSuffix(bytes.TrimSpace(data), []byte("%%EOF")) {
			return invalid("file", "Файл должен быть в формате PDF.")
		}
	case "image/png", "image/jpeg":
		config, format, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 40000000 {
			return invalid("file", "Изображение повреждено или слишком большое. Уменьшите его и загрузите снова.")
		}
		if media == "image/png" && (format != "png" || ext != ".png") || media == "image/jpeg" && (format != "jpeg" || (ext != ".jpg" && ext != ".jpeg")) {
			return invalid("file", "Расширение файла не совпадает с его содержимым. Сохраните изображение как JPEG или PNG заново.")
		}
	default:
		return invalid("file", "Разрешены PDF, JPEG и PNG.")
	}
	return nil
}
