package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"
)

const DefaultMaxBodyBytes int64 = 1 << 20

// DecodeJSON reads one JSON object into a DTO pointer, rejects unknown fields,
// and limits the whole body, including trailing whitespace. Use only on routes
// that expect a body; it does not impose body requirements on GET or health.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) *Problem {
	return DecodeJSONLimit(w, r, dst, DefaultMaxBodyBytes)
}

// DecodeJSONLimit permits a route-specific positive limit. On failure the
// partially decoded DTO must be discarded. Raw decoder errors are never exposed.
func DecodeJSONLimit(w http.ResponseWriter, r *http.Request, dst any, maxBytes int64) *Problem {
	if maxBytes <= 0 {
		panic("httpapi: body limit must be positive")
	}
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" || (params["charset"] != "" && !strings.EqualFold(params["charset"], "utf-8")) {
		return NewProblem(http.StatusUnsupportedMediaType, "unsupported_media_type", "Не удалось прочитать отправленные данные. Обновите страницу и повторите.")
	}
	if r.Body == nil {
		return invalidJSON()
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return NewProblem(http.StatusRequestEntityTooLarge, "body_too_large", "Превышен допустимый размер тела запроса.")
		}
		return invalidJSON()
	}
	body = bytes.Trim(body, " \t\r\n")
	if len(body) == 0 || body[0] != '{' || !utf8.Valid(body) {
		return invalidJSON()
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		var invalidTarget *json.InvalidUnmarshalError
		if errors.As(err, &invalidTarget) {
			panic(err) // A programming error, not an invalid client request.
		}
		return invalidJSON()
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return invalidJSON()
	}
	return nil
}

func invalidJSON() *Problem {
	return NewProblem(http.StatusBadRequest, "invalid_json", "Не удалось прочитать отправленные данные. Обновите страницу и повторите.")
}

// WriteJSON encodes a DTO before sending headers so encoding failures can still
// become a safe 500 response. Use with the recovery middleware.
func WriteJSON(w http.ResponseWriter, status int, value any) {
	writeJSON(w, status, "application/json", value)
}

func writeJSON(w http.ResponseWriter, status int, contentType string, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(status)
	if _, err := w.Write(append(body, '\n')); err != nil {
		panic(http.ErrAbortHandler)
	}
}
