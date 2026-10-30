package app

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// People read API messages on screen, so Russian texts must not carry formats,
// type limits or protocol words they cannot act on.
func TestRussianMessagesHaveNoTechnicalWords(t *testing.T) {
	cyrillic := regexp.MustCompile(`[А-Яа-яЁё]`)
	technical := regexp.MustCompile(`YYYY|UTC|\bID\b|int32|int64|RFC ?3339|IANA|multipart|JSON|Content-Type|\bnull\b|МиБ|format=|\bfrom\b|\blimit\b|\bafter\b`)
	err := filepath.WalkDir("..", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if ok && isLogCall(call) {
				return false // log lines are for operators, not for people on screen
			}
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			text, err := strconv.Unquote(lit.Value)
			if err == nil && cyrillic.MatchString(text) && technical.MatchString(text) {
				t.Errorf("%s: technical word in %q", path, text)
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func isLogCall(call *ast.CallExpr) bool {
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	name := selector.Sel.Name
	return strings.HasPrefix(name, "Warn") || strings.HasPrefix(name, "Info") || strings.HasPrefix(name, "Error") || strings.HasPrefix(name, "Debug")
}
