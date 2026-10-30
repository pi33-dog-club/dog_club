package httpapi

import "net/http"

// FieldError identifies a DTO field using its JSON name (nested fields may use
// dot notation). Code is stable; Message is safe text for the user.
type FieldError struct {
	Field   string `json:"field"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ValidationProblem returns nil when all checks passed. Handlers collect format
// errors explicitly; business rules remain in the service of each module.
func ValidationProblem(fields ...FieldError) *Problem {
	if len(fields) == 0 {
		return nil
	}
	problem := NewProblem(http.StatusUnprocessableEntity, "validation_failed", "Исправьте ошибки в форме.")
	problem.Errors = append([]FieldError(nil), fields...)
	return problem
}
