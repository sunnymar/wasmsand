#!/usr/bin/env python3
# Test cases adapted from uutils/coreutils (MIT License)
#
# Comprehensive test suite for codepod coreutils.
# Run: python3 test_coreutils.py
#
# Tests are designed to work both inside the codepod sandbox (where coreutils
# are in PATH) and on a normal system with GNU/BSD coreutils installed.

import subprocess
import os
import sys
import tempfile

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------

passed = 0
failed = 0
skipped = 0
errors = []

def run(args, input=None, timeout=10):
    """Run a command and return the CompletedProcess."""
    return subprocess.run(args, capture_output=True, text=True, input=input, timeout=timeout)

def run_bytes(args, input=None, timeout=10):
    """Run a command and return stdout/stderr as bytes."""
    return subprocess.run(args, capture_output=True, input=input, timeout=timeout)

def test(name, func):
    global passed, failed
    try:
        func()
        passed += 1
        print(f"  PASS  {name}")
    except AssertionError as e:
        failed += 1
        errors.append((name, str(e)))
        print(f"  FAIL  {name}: {e}")
    except Exception as e:
        failed += 1
        errors.append((name, str(e)))
        print(f"  ERROR {name}: {e}")

def skip(name, reason=""):
    global skipped
    skipped += 1
    print(f"  SKIP  {name}{': ' + reason if reason else ''}")

class TempFiles:
    """Context manager that creates temp files for testing."""
    def __init__(self, files):
        # files: dict of filename -> content (str or bytes)
        self._files = files
        self._dir = None
        self._paths = {}

    def __enter__(self):
        self._dir = tempfile.mkdtemp()
        for name, content in self._files.items():
            path = os.path.join(self._dir, name)
            if isinstance(content, bytes):
                with open(path, "wb") as f:
                    f.write(content)
            else:
                with open(path, "w") as f:
                    f.write(content)
            self._paths[name] = path
        return self._paths

    def __exit__(self, *args):
        import shutil
        shutil.rmtree(self._dir, ignore_errors=True)

# ---------------------------------------------------------------------------
# 1. echo
# ---------------------------------------------------------------------------

def register_echo_tests():
    print("\n=== echo ===")

    def test_echo_default():
        r = run(["echo", "hi"])
        assert r.stdout == "hi\n", f"expected 'hi\\n', got {r.stdout!r}"
    test("echo_default", test_echo_default)

    def test_echo_no_trailing_newline():
        r = run(["echo", "-n", "hi"])
        assert r.stdout == "hi", f"expected 'hi', got {r.stdout!r}"
    test("echo_no_trailing_newline", test_echo_no_trailing_newline)

    def test_echo_empty_args():
        r = run(["echo"])
        assert r.stdout == "\n", f"expected '\\n', got {r.stdout!r}"
    test("echo_empty_args", test_echo_empty_args)

    def test_echo_escape_alert():
        r = run(["echo", "-e", "\\a"])
        assert r.stdout == "\x07\n", f"expected '\\x07\\n', got {r.stdout!r}"
    test("echo_escape_alert", test_echo_escape_alert)

    def test_echo_escape_backslash():
        r = run(["echo", "-e", "\\\\"])
        assert r.stdout == "\\\n", f"expected '\\\\\\n', got {r.stdout!r}"
    test("echo_escape_backslash", test_echo_escape_backslash)

    def test_echo_escape_backspace():
        r = run(["echo", "-e", "\\b"])
        assert r.stdout == "\x08\n", f"expected '\\x08\\n', got {r.stdout!r}"
    test("echo_escape_backspace", test_echo_escape_backspace)

    def test_echo_escape_carriage_return():
        r = run(["echo", "-e", "\\r"])
        assert r.stdout == "\r\n", f"expected '\\r\\n', got {r.stdout!r}"
    test("echo_escape_carriage_return", test_echo_escape_carriage_return)

    def test_echo_escape_tab():
        r = run(["echo", "-e", "\\t"])
        assert r.stdout == "\t\n", f"expected '\\t\\n', got {r.stdout!r}"
    test("echo_escape_tab", test_echo_escape_tab)

    def test_echo_escape_newline():
        r = run(["echo", "-e", "\\na"])
        assert r.stdout == "\na\n", f"expected '\\na\\n', got {r.stdout!r}"
    test("echo_escape_newline", test_echo_escape_newline)

    def test_echo_escape_hex():
        r = run(["echo", "-e", "\\x41"])
        assert r.stdout == "A\n", f"expected 'A\\n', got {r.stdout!r}"
    test("echo_escape_hex", test_echo_escape_hex)

    def test_echo_escape_octal():
        r = run(["echo", "-e", "\\0100"])
        assert r.stdout == "@\n", f"expected '@\\n', got {r.stdout!r}"
    test("echo_escape_octal", test_echo_escape_octal)

    def test_echo_escape_short_octal():
        r = run(["echo", "-e", "foo\\040bar"])
        assert r.stdout == "foo bar\n", f"expected 'foo bar\\n', got {r.stdout!r}"
    test("echo_escape_short_octal", test_echo_escape_short_octal)

    def test_echo_escape_no_further_output():
        r = run(["echo", "-e", "a\\cb", "c"])
        assert r.stdout == "a", f"expected 'a', got {r.stdout!r}"
    test("echo_escape_no_further_output", test_echo_escape_no_further_output)

    def test_echo_escape_vertical_tab():
        r = run(["echo", "-e", "\\v"])
        assert r.stdout == "\x0B\n", f"expected '\\x0B\\n', got {r.stdout!r}"
    test("echo_escape_vertical_tab", test_echo_escape_vertical_tab)

    def test_echo_escape_form_feed():
        r = run(["echo", "-e", "\\f"])
        assert r.stdout == "\x0C\n", f"expected '\\x0C\\n', got {r.stdout!r}"
    test("echo_escape_form_feed", test_echo_escape_form_feed)

    def test_echo_multiple_args():
        r = run(["echo", "hello", "world"])
        assert r.stdout == "hello world\n", f"expected 'hello world\\n', got {r.stdout!r}"
    test("echo_multiple_args", test_echo_multiple_args)

    def test_echo_E_disables_escapes():
        r = run(["echo", "-E", "\\n"])
        assert r.stdout == "\\n\n", f"expected '\\\\n\\n', got {r.stdout!r}"
    test("echo_E_disables_escapes", test_echo_E_disables_escapes)


# ---------------------------------------------------------------------------
# 2. basename
# ---------------------------------------------------------------------------

def register_basename_tests():
    print("\n=== basename ===")

    def test_basename_directory():
        r = run(["basename", "/root/alpha/beta/gamma/delta/epsilon/omega/"])
        assert r.stdout == "omega\n", f"expected 'omega\\n', got {r.stdout!r}"
    test("basename_directory", test_basename_directory)

    def test_basename_file():
        r = run(["basename", "/etc/passwd"])
        assert r.stdout == "passwd\n", f"expected 'passwd\\n', got {r.stdout!r}"
    test("basename_file", test_basename_file)

    def test_basename_remove_suffix():
        r = run(["basename", "/usr/local/bin/reallylongexecutable.exe", ".exe"])
        assert r.stdout == "reallylongexecutable\n", f"got {r.stdout!r}"
    test("basename_remove_suffix", test_basename_remove_suffix)

    def test_basename_do_not_remove_suffix():
        # When the suffix matches the entire basename, it should not be removed
        r = run(["basename", "/foo/bar/baz", "baz"])
        assert r.stdout == "baz\n", f"got {r.stdout!r}"
    test("basename_do_not_remove_suffix", test_basename_do_not_remove_suffix)

    def test_basename_multiple():
        r = run(["basename", "-a", "/foo/bar/baz", "/foo/bar/baz"])
        assert r.stdout == "baz\nbaz\n", f"got {r.stdout!r}"
    test("basename_multiple", test_basename_multiple)

    def test_basename_suffix_param():
        r = run(["basename", "-s", ".exe", "/foo/bar/baz.exe", "/foo/bar/baz.exe"])
        assert r.stdout == "baz\nbaz\n", f"got {r.stdout!r}"
    test("basename_suffix_param", test_basename_suffix_param)

    def test_basename_zero_terminated():
        r = run(["basename", "-z", "-a", "/foo/bar/baz", "/foo/bar/baz"])
        assert r.stdout == "baz\0baz\0", f"got {r.stdout!r}"
    test("basename_zero_terminated", test_basename_zero_terminated)

    def test_basename_root():
        r = run(["basename", "/"])
        assert r.stdout == "/\n", f"got {r.stdout!r}"
    test("basename_root", test_basename_root)

    def test_basename_trailing_dot():
        r = run(["basename", "/."])
        assert r.stdout == ".\n", f"got {r.stdout!r}"
    test("basename_trailing_dot", test_basename_trailing_dot)

    def test_basename_simple_suffix():
        r = run(["basename", "a-a", "-a"])
        assert r.stdout == "a\n", f"got {r.stdout!r}"
    test("basename_simple_suffix", test_basename_simple_suffix)

    def test_basename_no_args():
        r = run(["basename"])
        assert r.returncode != 0, "expected nonzero exit code"
    test("basename_no_args", test_basename_no_args)

    def test_basename_too_many_args():
        r = run(["basename", "a", "b", "c"])
        assert r.returncode != 0, "expected nonzero exit code"
    test("basename_too_many_args", test_basename_too_many_args)


# ---------------------------------------------------------------------------
# 3. seq
# ---------------------------------------------------------------------------

def register_seq_tests():
    print("\n=== seq ===")

    def test_seq_count_up():
        r = run(["seq", "10"])
        assert r.stdout == "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", f"got {r.stdout!r}"
    test("seq_count_up", test_seq_count_up)

    def test_seq_count_down():
        r = run(["seq", "5", "-1", "1"])
        assert r.stdout == "5\n4\n3\n2\n1\n", f"got {r.stdout!r}"
    test("seq_count_down", test_seq_count_down)

    def test_seq_two_args():
        r = run(["seq", "3", "6"])
        assert r.stdout == "3\n4\n5\n6\n", f"got {r.stdout!r}"
    test("seq_two_args", test_seq_two_args)

    def test_seq_separator():
        r = run(["seq", "-s", ",", "2", "6"])
        assert r.stdout == "2,3,4,5,6\n", f"got {r.stdout!r}"
    test("seq_separator", test_seq_separator)

    def test_seq_separator_empty():
        r = run(["seq", "-s", "", "2", "6"])
        assert r.stdout == "23456\n", f"got {r.stdout!r}"
    test("seq_separator_empty", test_seq_separator_empty)

    def test_seq_equal_width():
        r = run(["seq", "-w", "8", "12"])
        assert r.stdout == "08\n09\n10\n11\n12\n", f"got {r.stdout!r}"
    test("seq_equal_width", test_seq_equal_width)

    def test_seq_negative():
        r = run(["seq", "--", "-1", "2"])
        assert r.stdout == "-1\n0\n1\n2\n", f"got {r.stdout!r}"
    test("seq_negative", test_seq_negative)

    def test_seq_decimal():
        r = run(["seq", "0.5", "0.5", "2.0"])
        lines = r.stdout.strip().split("\n")
        # Should produce 0.5 1.0 1.5 2.0
        assert len(lines) == 4, f"expected 4 lines, got {len(lines)}: {lines}"
    test("seq_decimal", test_seq_decimal)

    def test_seq_single_number():
        r = run(["seq", "1"])
        assert r.stdout == "1\n", f"got {r.stdout!r}"
    test("seq_single_number", test_seq_single_number)

    def test_seq_invalid_arg():
        r = run(["seq", "foo"])
        assert r.returncode != 0, "expected nonzero exit code for invalid arg"
    test("seq_invalid_arg", test_seq_invalid_arg)


# ---------------------------------------------------------------------------
# 4. wc
# ---------------------------------------------------------------------------

def register_wc_tests():
    print("\n=== wc ===")

    def test_wc_lines():
        r = run(["wc", "-l"], input="one\ntwo\nthree\n")
        assert r.stdout.strip() == "3", f"got {r.stdout!r}"
    test("wc_lines", test_wc_lines)

    def test_wc_words():
        r = run(["wc", "-w"], input="hello world foo bar\n")
        assert r.stdout.strip() == "4", f"got {r.stdout!r}"
    test("wc_words", test_wc_words)

    def test_wc_bytes():
        r = run(["wc", "-c"], input="hello\n")
        assert r.stdout.strip() == "6", f"got {r.stdout!r}"
    test("wc_bytes", test_wc_bytes)

    def test_wc_chars():
        r = run(["wc", "-m"], input="hello\n")
        assert r.stdout.strip() == "6", f"got {r.stdout!r}"
    test("wc_chars", test_wc_chars)

    def test_wc_empty_input():
        r = run(["wc", "-l"], input="")
        assert r.stdout.strip() == "0", f"got {r.stdout!r}"
    test("wc_empty_input", test_wc_empty_input)

    def test_wc_no_trailing_newline():
        r = run(["wc", "-l"], input="no newline")
        assert r.stdout.strip() == "0", f"got {r.stdout!r}"
    test("wc_no_trailing_newline", test_wc_no_trailing_newline)

    def test_wc_default():
        # Default should show lines, words, bytes
        r = run(["wc"], input="hello world\nfoo bar\n")
        parts = r.stdout.split()
        assert parts[0] == "2", f"expected 2 lines, got {parts}"
        assert parts[1] == "4", f"expected 4 words, got {parts}"
    test("wc_default", test_wc_default)

    def test_wc_multiple_files():
        with TempFiles({"a.txt": "hello\n", "b.txt": "world\n"}) as paths:
            r = run(["wc", "-l", paths["a.txt"], paths["b.txt"]])
            assert r.returncode == 0, f"wc failed: {r.stderr}"
            assert "total" in r.stdout, f"expected 'total' in output: {r.stdout!r}"
    test("wc_multiple_files", test_wc_multiple_files)

    def test_wc_bytes_large():
        data = "x" * 1000
        r = run(["wc", "-c"], input=data)
        assert r.stdout.strip() == "1000", f"got {r.stdout!r}"
    test("wc_bytes_large", test_wc_bytes_large)

    def test_wc_multibyte_chars():
        # 3-byte UTF-8 character
        r = run(["wc", "-m"], input="\u20ac\n")
        assert r.stdout.strip() == "2", f"got {r.stdout!r}"
    test("wc_multibyte_chars", test_wc_multibyte_chars)


# ---------------------------------------------------------------------------
# 5. cut
# ---------------------------------------------------------------------------

def register_cut_tests():
    print("\n=== cut ===")

    def test_cut_fields():
        r = run(["cut", "-f", "2", "-d", ":"], input="a:b:c\nd:e:f\n")
        assert r.stdout == "b\ne\n", f"got {r.stdout!r}"
    test("cut_fields", test_cut_fields)

    def test_cut_fields_range():
        r = run(["cut", "-f", "1-2", "-d", ":"], input="a:b:c\nd:e:f\n")
        assert r.stdout == "a:b\nd:e\n", f"got {r.stdout!r}"
    test("cut_fields_range", test_cut_fields_range)

    def test_cut_chars():
        r = run(["cut", "-c", "2-4"], input="abcdef\n")
        assert r.stdout == "bcd\n", f"got {r.stdout!r}"
    test("cut_chars", test_cut_chars)

    def test_cut_chars_single():
        r = run(["cut", "-c", "1"], input="abcdef\n")
        assert r.stdout == "a\n", f"got {r.stdout!r}"
    test("cut_chars_single", test_cut_chars_single)

    def test_cut_bytes():
        r = run(["cut", "-b", "1-3"], input="abcdef\n")
        assert r.stdout == "abc\n", f"got {r.stdout!r}"
    test("cut_bytes", test_cut_bytes)

    def test_cut_delimiter():
        r = run(["cut", "-d", ",", "-f", "2"], input="hello,world,foo\n")
        assert r.stdout == "world\n", f"got {r.stdout!r}"
    test("cut_delimiter", test_cut_delimiter)

    def test_cut_only_delimited():
        r = run(["cut", "-s", "-d", ":", "-f", "1"], input="no-delim\nhas:delim\n")
        assert r.stdout == "has\n", f"got {r.stdout!r}"
    test("cut_only_delimited", test_cut_only_delimited)

    def test_cut_complement():
        r = run(["cut", "--complement", "-d", "_", "-f", "2"], input="9_1\n8_2\n7_3\n")
        assert r.stdout == "9\n8\n7\n", f"got {r.stdout!r}"
    test("cut_complement", test_cut_complement)

    def test_cut_output_delimiter():
        r = run(["cut", "-d", ":", "--output-delimiter=@", "-f", "1,3"], input="a:b:c\n")
        assert r.stdout == "a@c\n", f"got {r.stdout!r}"
    test("cut_output_delimiter", test_cut_output_delimiter)

    def test_cut_no_args():
        r = run(["cut"])
        assert r.returncode != 0, "expected nonzero exit code"
    test("cut_no_args", test_cut_no_args)


# ---------------------------------------------------------------------------
# 6. head
# ---------------------------------------------------------------------------

def register_head_tests():
    print("\n=== head ===")

    lines20 = "".join(f"line{i}\n" for i in range(1, 21))

    def test_head_default():
        r = run(["head"], input=lines20)
        expected = "".join(f"line{i}\n" for i in range(1, 11))
        assert r.stdout == expected, f"got {r.stdout!r}"
    test("head_default", test_head_default)

    def test_head_n1():
        r = run(["head", "-n", "1"], input=lines20)
        assert r.stdout == "line1\n", f"got {r.stdout!r}"
    test("head_n1", test_head_n1)

    def test_head_n5():
        r = run(["head", "-n", "5"], input=lines20)
        expected = "".join(f"line{i}\n" for i in range(1, 6))
        assert r.stdout == expected, f"got {r.stdout!r}"
    test("head_n5", test_head_n5)

    def test_head_c5():
        r = run(["head", "-c", "5"], input="abcdefghij")
        assert r.stdout == "abcde", f"got {r.stdout!r}"
    test("head_c5", test_head_c5)

    def test_head_no_trailing_newline():
        r = run(["head"], input="a")
        assert r.stdout == "a", f"got {r.stdout!r}"
    test("head_no_trailing_newline", test_head_no_trailing_newline)

    def test_head_n_negative():
        # head -n -1 means all but the last line
        r = run(["head", "-n", "-1"], input="a\nb\nc\n")
        assert r.stdout == "a\nb\n", f"got {r.stdout!r}"
    test("head_n_negative", test_head_n_negative)

    def test_head_multiple_files():
        with TempFiles({"a.txt": "alpha\n", "b.txt": "beta\n"}) as paths:
            r = run(["head", paths["a.txt"], paths["b.txt"]])
            assert "alpha" in r.stdout, f"missing alpha in {r.stdout!r}"
            assert "beta" in r.stdout, f"missing beta in {r.stdout!r}"
    test("head_multiple_files", test_head_multiple_files)

    def test_head_byte_syntax():
        r = run(["head", "-c", "1"], input="abc")
        assert r.stdout == "a", f"got {r.stdout!r}"
    test("head_byte_syntax", test_head_byte_syntax)


# ---------------------------------------------------------------------------
# 7. tail
# ---------------------------------------------------------------------------

def register_tail_tests():
    print("\n=== tail ===")

    lines20 = "".join(f"line{i}\n" for i in range(1, 21))

    def test_tail_default():
        r = run(["tail"], input=lines20)
        expected = "".join(f"line{i}\n" for i in range(11, 21))
        assert r.stdout == expected, f"got {r.stdout!r}"
    test("tail_default", test_tail_default)

    def test_tail_n5():
        r = run(["tail", "-n", "5"], input=lines20)
        expected = "".join(f"line{i}\n" for i in range(16, 21))
        assert r.stdout == expected, f"got {r.stdout!r}"
    test("tail_n5", test_tail_n5)

    def test_tail_n1():
        r = run(["tail", "-n", "1"], input=lines20)
        assert r.stdout == "line20\n", f"got {r.stdout!r}"
    test("tail_n1", test_tail_n1)

    def test_tail_c5():
        r = run(["tail", "-c", "5"], input="abcdefghij")
        assert r.stdout == "fghij", f"got {r.stdout!r}"
    test("tail_c5", test_tail_c5)

    def test_tail_from_beginning():
        # tail -n +3 means start from line 3
        r = run(["tail", "-n", "+3"], input="a\nb\nc\nd\ne\n")
        assert r.stdout == "c\nd\ne\n", f"got {r.stdout!r}"
    test("tail_from_beginning", test_tail_from_beginning)

    def test_tail_n_plus1():
        r = run(["tail", "-n", "+1"], input="a\nb\nc\n")
        assert r.stdout == "a\nb\nc\n", f"got {r.stdout!r}"
    test("tail_n_plus1", test_tail_n_plus1)

    def test_tail_empty_input():
        r = run(["tail"], input="")
        assert r.stdout == "", f"got {r.stdout!r}"
    test("tail_empty_input", test_tail_empty_input)

    def test_tail_no_trailing_newline():
        r = run(["tail", "-n", "1"], input="a\nb")
        assert r.stdout == "b", f"got {r.stdout!r}"
    test("tail_no_trailing_newline", test_tail_no_trailing_newline)


# ---------------------------------------------------------------------------
# 8. sort
# ---------------------------------------------------------------------------

def register_sort_tests():
    print("\n=== sort ===")

    def test_sort_basic():
        r = run(["sort"], input="banana\napple\ncherry\n")
        assert r.stdout == "apple\nbanana\ncherry\n", f"got {r.stdout!r}"
    test("sort_basic", test_sort_basic)

    def test_sort_reverse():
        r = run(["sort", "-r"], input="banana\napple\ncherry\n")
        assert r.stdout == "cherry\nbanana\napple\n", f"got {r.stdout!r}"
    test("sort_reverse", test_sort_reverse)

    def test_sort_numeric():
        r = run(["sort", "-n"], input="10\n2\n1\n20\n3\n")
        assert r.stdout == "1\n2\n3\n10\n20\n", f"got {r.stdout!r}"
    test("sort_numeric", test_sort_numeric)

    def test_sort_unique():
        r = run(["sort", "-u"], input="b\na\nb\nc\na\n")
        assert r.stdout == "a\nb\nc\n", f"got {r.stdout!r}"
    test("sort_unique", test_sort_unique)

    def test_sort_key():
        r = run(["sort", "-t", ",", "-k", "2"], input="b,2\na,3\nc,1\n")
        assert r.stdout == "c,1\nb,2\na,3\n", f"got {r.stdout!r}"
    test("sort_key", test_sort_key)

    def test_sort_key_numeric():
        r = run(["sort", "-t", ",", "-k", "2", "-n"], input="b,10\na,2\nc,1\n")
        assert r.stdout == "c,1\na,2\nb,10\n", f"got {r.stdout!r}"
    test("sort_key_numeric", test_sort_key_numeric)

    def test_sort_stable():
        # Stable sort should preserve input order for equal keys
        r = run(["sort", "-s", "-t", ",", "-k", "1,1"], input="a,1\na,2\nb,1\n")
        assert r.stdout == "a,1\na,2\nb,1\n", f"got {r.stdout!r}"
    test("sort_stable", test_sort_stable)

    def test_sort_case_insensitive():
        r = run(["sort", "-f"], input="Banana\napple\nCherry\n")
        assert r.stdout == "apple\nBanana\nCherry\n", f"got {r.stdout!r}"
    test("sort_case_insensitive", test_sort_case_insensitive)

    def test_sort_numeric_reverse():
        r = run(["sort", "-n", "-r"], input="1\n3\n2\n")
        assert r.stdout == "3\n2\n1\n", f"got {r.stdout!r}"
    test("sort_numeric_reverse", test_sort_numeric_reverse)

    def test_sort_already_sorted():
        r = run(["sort"], input="a\nb\nc\n")
        assert r.stdout == "a\nb\nc\n", f"got {r.stdout!r}"
    test("sort_already_sorted", test_sort_already_sorted)


# ---------------------------------------------------------------------------
# 9. uniq
# ---------------------------------------------------------------------------

def register_uniq_tests():
    print("\n=== uniq ===")

    def test_uniq_basic():
        r = run(["uniq"], input="a\na\nb\nc\nc\n")
        assert r.stdout == "a\nb\nc\n", f"got {r.stdout!r}"
    test("uniq_basic", test_uniq_basic)

    def test_uniq_count():
        r = run(["uniq", "-c"], input="a\na\nb\nc\nc\nc\n")
        lines = [l.strip() for l in r.stdout.strip().split("\n")]
        assert lines[0] == "2 a", f"got {lines}"
        assert lines[1] == "1 b", f"got {lines}"
        assert lines[2] == "3 c", f"got {lines}"
    test("uniq_count", test_uniq_count)

    def test_uniq_duplicates_only():
        r = run(["uniq", "-d"], input="a\na\nb\nc\nc\n")
        assert r.stdout == "a\nc\n", f"got {r.stdout!r}"
    test("uniq_duplicates_only", test_uniq_duplicates_only)

    def test_uniq_unique_only():
        r = run(["uniq", "-u"], input="a\na\nb\nc\nc\n")
        assert r.stdout == "b\n", f"got {r.stdout!r}"
    test("uniq_unique_only", test_uniq_unique_only)

    def test_uniq_ignore_case():
        r = run(["uniq", "-i"], input="Hello\nhello\nWorld\n")
        assert r.stdout == "Hello\nWorld\n", f"got {r.stdout!r}"
    test("uniq_ignore_case", test_uniq_ignore_case)

    def test_uniq_empty_input():
        r = run(["uniq"], input="")
        assert r.stdout == "", f"got {r.stdout!r}"
    test("uniq_empty_input", test_uniq_empty_input)

    def test_uniq_single_line():
        r = run(["uniq"], input="hello\n")
        assert r.stdout == "hello\n", f"got {r.stdout!r}"
    test("uniq_single_line", test_uniq_single_line)

    def test_uniq_all_same():
        r = run(["uniq"], input="x\nx\nx\n")
        assert r.stdout == "x\n", f"got {r.stdout!r}"
    test("uniq_all_same", test_uniq_all_same)

    def test_uniq_count_and_ignore_case():
        r = run(["uniq", "-c", "-i"], input="A\na\nB\n")
        lines = [l.strip() for l in r.stdout.strip().split("\n")]
        assert lines[0] == "2 A", f"got {lines}"
        assert lines[1] == "1 B", f"got {lines}"
    test("uniq_count_and_ignore_case", test_uniq_count_and_ignore_case)


# ---------------------------------------------------------------------------
# 10. base64
# ---------------------------------------------------------------------------

def register_base64_tests():
    print("\n=== base64 ===")

    def test_base64_encode():
        r = run(["base64"], input="hello, world!")
        assert r.stdout.strip() == "aGVsbG8sIHdvcmxkIQ==", f"got {r.stdout!r}"
    test("base64_encode", test_base64_encode)

    def test_base64_decode():
        r = run(["base64", "-d"], input="aGVsbG8sIHdvcmxkIQ==")
        assert r.stdout == "hello, world!", f"got {r.stdout!r}"
    test("base64_decode", test_base64_decode)

    def test_base64_decode_short():
        r = run(["base64", "--decode"], input="aQ")
        assert r.stdout == "i", f"got {r.stdout!r}"
    test("base64_decode_short", test_base64_decode_short)

    def test_base64_decode_unpadded():
        r = run(["base64", "--decode"], input="MTIzNA")
        assert r.stdout == "1234", f"got {r.stdout!r}"
    test("base64_decode_unpadded", test_base64_decode_unpadded)

    def test_base64_decode_multiline():
        r = run(["base64", "--decode"], input="aQ\n\n\n")
        assert r.stdout == "i", f"got {r.stdout!r}"
    test("base64_decode_multiline", test_base64_decode_multiline)

    def test_base64_wrap():
        inp = "The quick brown fox jumps over the lazy dog."
        r = run(["base64", "-w", "20"], input=inp)
        lines = r.stdout.strip().split("\n")
        for line in lines[:-1]:
            assert len(line) == 20, f"expected line width 20, got {len(line)}: {line!r}"
    test("base64_wrap", test_base64_wrap)

    def test_base64_wrap_zero():
        r = run(["base64", "-w", "0"], input="hello, world")
        assert r.stdout == "aGVsbG8sIHdvcmxk", f"got {r.stdout!r}"
    test("base64_wrap_zero", test_base64_wrap_zero)

    def test_base64_roundtrip():
        data = "Hello World! 1234 !@#$%"
        enc = run(["base64"], input=data)
        dec = run(["base64", "-d"], input=enc.stdout)
        assert dec.stdout == data, f"roundtrip failed: got {dec.stdout!r}"
    test("base64_roundtrip", test_base64_roundtrip)


# ---------------------------------------------------------------------------
# 11. fold
# ---------------------------------------------------------------------------

def register_fold_tests():
    print("\n=== fold ===")

    def test_fold_default():
        # Default is 80 columns
        line = "a" * 100 + "\n"
        r = run(["fold"], input=line)
        lines = r.stdout.split("\n")
        assert len(lines[0]) == 80, f"got line length {len(lines[0])}"
        assert lines[1] == "a" * 20, f"got {lines[1]!r}"
    test("fold_default", test_fold_default)

    def test_fold_width():
        r = run(["fold", "-w", "5"], input="abcdefghij\n")
        assert r.stdout == "abcde\nfghij\n", f"got {r.stdout!r}"
    test("fold_width", test_fold_width)

    def test_fold_break_spaces():
        r = run(["fold", "-s", "-w", "10"], input="hello world foo bar\n")
        # Should break at spaces within width
        for line in r.stdout.strip().split("\n"):
            assert len(line) <= 10, f"line too long: {line!r}"
    test("fold_break_spaces", test_fold_break_spaces)

    def test_fold_short_lines():
        r = run(["fold", "-w", "80"], input="short\n")
        assert r.stdout == "short\n", f"got {r.stdout!r}"
    test("fold_short_lines", test_fold_short_lines)

    def test_fold_empty():
        r = run(["fold"], input="")
        assert r.stdout == "", f"got {r.stdout!r}"
    test("fold_empty", test_fold_empty)


# ---------------------------------------------------------------------------
# 12. paste
# ---------------------------------------------------------------------------

def register_paste_tests():
    print("\n=== paste ===")

    def test_paste_two_files():
        with TempFiles({"a.txt": "1\n2\n", "b.txt": "a\nb\n"}) as paths:
            r = run(["paste", paths["a.txt"], paths["b.txt"]])
            assert r.stdout == "1\ta\n2\tb\n", f"got {r.stdout!r}"
    test("paste_two_files", test_paste_two_files)

    def test_paste_delimiter():
        with TempFiles({"a.txt": "1\n2\n", "b.txt": "a\nb\n"}) as paths:
            r = run(["paste", "-d", ",", paths["a.txt"], paths["b.txt"]])
            assert r.stdout == "1,a\n2,b\n", f"got {r.stdout!r}"
    test("paste_delimiter", test_paste_delimiter)

    def test_paste_serial():
        with TempFiles({"a.txt": "1\n2\n3\n"}) as paths:
            r = run(["paste", "-s", paths["a.txt"]])
            assert r.stdout == "1\t2\t3\n", f"got {r.stdout!r}"
    test("paste_serial", test_paste_serial)

    def test_paste_stdin():
        r = run(["paste", "-s", "-d", ",", "-"], input="a\nb\nc\n")
        assert r.stdout == "a,b,c\n", f"got {r.stdout!r}"
    test("paste_stdin", test_paste_stdin)

    def test_paste_no_newline():
        with TempFiles({"a.txt": "a", "b.txt": "b"}) as paths:
            r = run(["paste", paths["a.txt"], paths["b.txt"]])
            assert r.stdout == "a\tb\n", f"got {r.stdout!r}"
    test("paste_no_newline", test_paste_no_newline)

    def test_paste_space_delimiter():
        with TempFiles({"a.txt": "1\na\n", "b.txt": "2\nb\n"}) as paths:
            r = run(["paste", "-d", " ", paths["a.txt"], paths["b.txt"]])
            assert r.stdout == "1 2\na b\n", f"got {r.stdout!r}"
    test("paste_space_delimiter", test_paste_space_delimiter)


# ---------------------------------------------------------------------------
# 13. tr
# ---------------------------------------------------------------------------

def register_tr_tests():
    print("\n=== tr ===")

    def test_tr_to_upper():
        r = run(["tr", "a-z", "A-Z"], input="!abcd!")
        assert r.stdout == "!ABCD!", f"got {r.stdout!r}"
    test("tr_to_upper", test_tr_to_upper)

    def test_tr_small_set2():
        r = run(["tr", "0-9", "X"], input="@0123456789")
        assert r.stdout == "@XXXXXXXXXX", f"got {r.stdout!r}"
    test("tr_small_set2", test_tr_small_set2)

    def test_tr_delete():
        r = run(["tr", "-d", "a-z"], input="aBcD")
        assert r.stdout == "BD", f"got {r.stdout!r}"
    test("tr_delete", test_tr_delete)

    def test_tr_delete_complement():
        r = run(["tr", "-d", "-c", "a-z"], input="aBcD")
        assert r.stdout == "ac", f"got {r.stdout!r}"
    test("tr_delete_complement", test_tr_delete_complement)

    def test_tr_delete_complement_digits():
        r = run(["tr", "-d", "-C", "0-9"], input="Phone: 01234 567890")
        assert r.stdout == "01234567890", f"got {r.stdout!r}"
    test("tr_delete_complement_digits", test_tr_delete_complement_digits)

    def test_tr_squeeze():
        r = run(["tr", "-s", "a-z"], input="aaBBcDcc")
        assert r.stdout == "aBBcDc", f"got {r.stdout!r}"
    test("tr_squeeze", test_tr_squeeze)

    def test_tr_squeeze_complement():
        r = run(["tr", "-sc", "a-z"], input="aaBBcDcc")
        assert r.stdout == "aaBcDcc", f"got {r.stdout!r}"
    test("tr_squeeze_complement", test_tr_squeeze_complement)

    def test_tr_translate_and_squeeze():
        r = run(["tr", "-s", "x", "y"], input="xx")
        assert r.stdout == "y", f"got {r.stdout!r}"
    test("tr_translate_and_squeeze", test_tr_translate_and_squeeze)

    def test_tr_complement_translate():
        r = run(["tr", "-c", "a", "X"], input="ab")
        assert r.stdout == "aX", f"got {r.stdout!r}"
    test("tr_complement_translate", test_tr_complement_translate)

    def test_tr_complement_digits():
        r = run(["tr", "-c", "0-9", "x"], input="Phone: 01234 567890")
        assert r.stdout == "xxxxxxx01234x567890", f"got {r.stdout!r}"
    test("tr_complement_digits", test_tr_complement_digits)


# ---------------------------------------------------------------------------
# 14. dirname
# ---------------------------------------------------------------------------

def register_dirname_tests():
    print("\n=== dirname ===")

    def test_dirname_basic():
        r = run(["dirname", "/usr/local/bin/foo"])
        assert r.stdout == "/usr/local/bin\n", f"got {r.stdout!r}"
    test("dirname_basic", test_dirname_basic)

    def test_dirname_root():
        r = run(["dirname", "/"])
        assert r.stdout == "/\n", f"got {r.stdout!r}"
    test("dirname_root", test_dirname_root)

    def test_dirname_no_slash():
        r = run(["dirname", "foo"])
        assert r.stdout == ".\n", f"got {r.stdout!r}"
    test("dirname_no_slash", test_dirname_no_slash)

    def test_dirname_trailing_slash():
        r = run(["dirname", "/usr/local/"])
        assert r.stdout == "/usr\n", f"got {r.stdout!r}"
    test("dirname_trailing_slash", test_dirname_trailing_slash)

    def test_dirname_dot():
        r = run(["dirname", "."])
        assert r.stdout == ".\n", f"got {r.stdout!r}"
    test("dirname_dot", test_dirname_dot)

    def test_dirname_double_dot():
        r = run(["dirname", ".."])
        assert r.stdout == ".\n", f"got {r.stdout!r}"
    test("dirname_double_dot", test_dirname_double_dot)

    def test_dirname_etc_passwd():
        r = run(["dirname", "/etc/passwd"])
        assert r.stdout == "/etc\n", f"got {r.stdout!r}"
    test("dirname_etc_passwd", test_dirname_etc_passwd)


# ---------------------------------------------------------------------------
# 15. Additional basename edge cases
# ---------------------------------------------------------------------------

def register_basename_edge_tests():
    print("\n=== basename (edge cases) ===")

    def test_basename_double_slash():
        r = run(["basename", "//"])
        assert r.stdout == "/\n", f"got {r.stdout!r}"
    test("basename_double_slash", test_basename_double_slash)

    def test_basename_triple_slash():
        r = run(["basename", "///"])
        assert r.stdout == "/\n", f"got {r.stdout!r}"
    test("basename_triple_slash", test_basename_triple_slash)

    def test_basename_hello_dot():
        r = run(["basename", "hello/."])
        assert r.stdout == ".\n", f"got {r.stdout!r}"
    test("basename_hello_dot", test_basename_hello_dot)

    def test_basename_plain_file():
        r = run(["basename", "myfile.txt"])
        assert r.stdout == "myfile.txt\n", f"got {r.stdout!r}"
    test("basename_plain_file", test_basename_plain_file)

    def test_basename_suffix_entire_name():
        # suffix should not remove the entire name
        r = run(["basename", "file.txt", "file.txt"])
        assert r.stdout == "file.txt\n", f"got {r.stdout!r}"
    test("basename_suffix_entire_name", test_basename_suffix_entire_name)


# ---------------------------------------------------------------------------
# Bonus: more seq tests
# ---------------------------------------------------------------------------

def register_seq_extra_tests():
    print("\n=== seq (extra) ===")

    def test_seq_separator_direct():
        r = run(["seq", "-s,", "2"])
        assert r.stdout == "1,2\n", f"got {r.stdout!r}"
    test("seq_separator_direct", test_seq_separator_direct)

    def test_seq_negative_to_positive():
        r = run(["seq", "-s,", "--", "-1", "2"])
        assert r.stdout == "-1,0,1,2\n", f"got {r.stdout!r}"
    test("seq_negative_to_positive", test_seq_negative_to_positive)

    def test_seq_zero_step():
        # step of 0 should fail
        r = run(["seq", "1", "0", "5"])
        assert r.returncode != 0, "expected nonzero exit code for zero step"
    test("seq_zero_step", test_seq_zero_step)

    def test_seq_equal_width_negative():
        r = run(["seq", "-w", "--", "-3", "3"])
        lines = r.stdout.strip().split("\n")
        # All lines should have the same width
        widths = set(len(l) for l in lines)
        assert len(widths) == 1, f"unequal widths: {widths}, lines: {lines}"
    test("seq_equal_width_negative", test_seq_equal_width_negative)


# ---------------------------------------------------------------------------
# Bonus: more sort tests
# ---------------------------------------------------------------------------

def register_sort_extra_tests():
    print("\n=== sort (extra) ===")

    def test_sort_from_file():
        with TempFiles({"data.txt": "cherry\napple\nbanana\n"}) as paths:
            r = run(["sort", paths["data.txt"]])
            assert r.stdout == "apple\nbanana\ncherry\n", f"got {r.stdout!r}"
    test("sort_from_file", test_sort_from_file)

    def test_sort_check_sorted():
        r = run(["sort", "-c"], input="a\nb\nc\n")
        assert r.returncode == 0, f"expected 0, got {r.returncode}"
    test("sort_check_sorted", test_sort_check_sorted)

    def test_sort_check_unsorted():
        r = run(["sort", "-c"], input="b\na\nc\n")
        assert r.returncode != 0, f"expected nonzero, got {r.returncode}"
    test("sort_check_unsorted", test_sort_check_unsorted)

    def test_sort_unique_numeric():
        r = run(["sort", "-n", "-u"], input="3\n1\n2\n1\n3\n")
        assert r.stdout == "1\n2\n3\n", f"got {r.stdout!r}"
    test("sort_unique_numeric", test_sort_unique_numeric)


# ---------------------------------------------------------------------------
# Bonus: more head/tail tests
# ---------------------------------------------------------------------------

def register_head_tail_extra_tests():
    print("\n=== head/tail (extra) ===")

    def test_head_zero_lines():
        r = run(["head", "-n", "0"], input="hello\nworld\n")
        assert r.stdout == "", f"got {r.stdout!r}"
    test("head_zero_lines", test_head_zero_lines)

    def test_head_c_negative():
        # head -c -2 means all but last 2 bytes
        r = run(["head", "-c", "-2"], input="abcdef")
        assert r.stdout == "abcd", f"got {r.stdout!r}"
    test("head_c_negative", test_head_c_negative)

    def test_tail_c_from_beginning():
        # tail -c +3 means starting from byte 3
        r = run(["tail", "-c", "+3"], input="abcdef")
        assert r.stdout == "cdef", f"got {r.stdout!r}"
    test("tail_c_from_beginning", test_tail_c_from_beginning)


# ---------------------------------------------------------------------------
# Bonus: more wc tests
# ---------------------------------------------------------------------------

def register_wc_extra_tests():
    print("\n=== wc (extra) ===")

    def test_wc_multiple_flags():
        r = run(["wc", "-l", "-w"], input="hello world\nfoo\n")
        parts = r.stdout.split()
        assert parts[0] == "2", f"expected 2 lines, got {parts}"
        assert parts[1] == "3", f"expected 3 words, got {parts}"
    test("wc_multiple_flags", test_wc_multiple_flags)

    def test_wc_only_newlines():
        r = run(["wc", "-l"], input="\n\n\n")
        assert r.stdout.strip() == "3", f"got {r.stdout!r}"
    test("wc_only_newlines", test_wc_only_newlines)

    def test_wc_words_multispace():
        r = run(["wc", "-w"], input="  hello   world  \n")
        assert r.stdout.strip() == "2", f"got {r.stdout!r}"
    test("wc_words_multispace", test_wc_words_multispace)


# ---------------------------------------------------------------------------
# Bonus: more cut tests
# ---------------------------------------------------------------------------

def register_cut_extra_tests():
    print("\n=== cut (extra) ===")

    def test_cut_field_prefix():
        r = run(["cut", "-f", "-2", "-d", ":"], input="a:b:c:d\n")
        assert r.stdout == "a:b\n", f"got {r.stdout!r}"
    test("cut_field_prefix", test_cut_field_prefix)

    def test_cut_field_suffix():
        r = run(["cut", "-f", "3-", "-d", ":"], input="a:b:c:d\n")
        assert r.stdout == "c:d\n", f"got {r.stdout!r}"
    test("cut_field_suffix", test_cut_field_suffix)

    def test_cut_chars_range_open():
        r = run(["cut", "-c", "3-"], input="abcdef\n")
        assert r.stdout == "cdef\n", f"got {r.stdout!r}"
    test("cut_chars_range_open", test_cut_chars_range_open)


# ---------------------------------------------------------------------------
# Bonus: more tr tests
# ---------------------------------------------------------------------------

def register_tr_extra_tests():
    print("\n=== tr (extra) ===")

    def test_tr_translate_and_squeeze_multiline():
        r = run(["tr", "-s", "x", "y"], input="xxaax\nxaaxx")
        assert r.stdout == "yaay\nyaay", f"got {r.stdout!r}"
    test("tr_translate_and_squeeze_multiline", test_tr_translate_and_squeeze_multiline)

    def test_tr_squeeze_complement_two_sets():
        r = run(["tr", "-sc", "a", "_"], input="test a aa with 3 ___ spaaaces +++")
        assert r.stdout == "_a_aa_aaa_", f"got {r.stdout!r}"
    test("tr_squeeze_complement_two_sets", test_tr_squeeze_complement_two_sets)

    def test_tr_class_upper_lower():
        r = run(["tr", "[:upper:]", "[:lower:]"], input="HELLO WORLD")
        assert r.stdout == "hello world", f"got {r.stdout!r}"
    test("tr_class_upper_lower", test_tr_class_upper_lower)


# ---------------------------------------------------------------------------
# Bonus: more base64 tests
# ---------------------------------------------------------------------------

def register_base64_extra_tests():
    print("\n=== base64 (extra) ===")

    def test_base64_empty():
        r = run(["base64"], input="")
        assert r.stdout == "", f"got {r.stdout!r}"
    test("base64_empty", test_base64_empty)

    def test_base64_newline():
        r = run(["base64"], input="\n")
        assert r.stdout.strip() == "Cg==", f"got {r.stdout!r}"
    test("base64_newline", test_base64_newline)

    def test_base64_decode_padded_unpadded():
        r = run(["base64", "--decode"], input="MTIzNA==MTIzNA")
        assert r.stdout == "12341234", f"got {r.stdout!r}"
    test("base64_decode_padded_unpadded", test_base64_decode_padded_unpadded)

    def test_base64_file():
        with TempFiles({"input.txt": "Hello, World!\n"}) as paths:
            r = run(["base64", paths["input.txt"]])
            assert r.stdout.strip() == "SGVsbG8sIFdvcmxkIQo=", f"got {r.stdout!r}"
    test("base64_file", test_base64_file)


# ---------------------------------------------------------------------------
# Bonus: more uniq tests
# ---------------------------------------------------------------------------

def register_uniq_extra_tests():
    print("\n=== uniq (extra) ===")

    def test_uniq_from_file():
        with TempFiles({"data.txt": "a\na\nb\nb\nc\n"}) as paths:
            r = run(["uniq", paths["data.txt"]])
            assert r.stdout == "a\nb\nc\n", f"got {r.stdout!r}"
    test("uniq_from_file", test_uniq_from_file)

    def test_uniq_no_duplicates():
        r = run(["uniq"], input="a\nb\nc\n")
        assert r.stdout == "a\nb\nc\n", f"got {r.stdout!r}"
    test("uniq_no_duplicates", test_uniq_no_duplicates)

    def test_uniq_all_repeated():
        r = run(["uniq", "--all-repeated"], input="a\na\nb\nc\nc\n")
        assert r.stdout == "a\na\nc\nc\n", f"got {r.stdout!r}"
    test("uniq_all_repeated", test_uniq_all_repeated)


# ---------------------------------------------------------------------------
# Bonus: more fold tests
# ---------------------------------------------------------------------------

def register_fold_extra_tests():
    print("\n=== fold (extra) ===")

    def test_fold_width_1():
        r = run(["fold", "-w", "1"], input="abc\n")
        assert r.stdout == "a\nb\nc\n", f"got {r.stdout!r}"
    test("fold_width_1", test_fold_width_1)

    def test_fold_multiline():
        r = run(["fold", "-w", "3"], input="abcdef\nghijkl\n")
        assert r.stdout == "abc\ndef\nghi\njkl\n", f"got {r.stdout!r}"
    test("fold_multiline", test_fold_multiline)

    def test_fold_stdin():
        r = run(["fold", "-w", "4"], input="12345678\n")
        assert r.stdout == "1234\n5678\n", f"got {r.stdout!r}"
    test("fold_stdin", test_fold_stdin)


# ---------------------------------------------------------------------------
# Bonus: more paste tests
# ---------------------------------------------------------------------------

def register_paste_extra_tests():
    print("\n=== paste (extra) ===")

    def test_paste_unequal_files():
        with TempFiles({"a.txt": "1\n2\n3\n", "b.txt": "a\nb\n"}) as paths:
            r = run(["paste", paths["a.txt"], paths["b.txt"]])
            lines = r.stdout.strip().split("\n")
            assert lines[0] == "1\ta", f"got {lines}"
            assert lines[1] == "2\tb", f"got {lines}"
            assert lines[2] == "3\t", f"got {lines}"
    test("paste_unequal_files", test_paste_unequal_files)

    def test_paste_serial_delimiter():
        with TempFiles({"a.txt": "1\n2\n3\n"}) as paths:
            r = run(["paste", "-s", "-d", ",", paths["a.txt"]])
            assert r.stdout == "1,2,3\n", f"got {r.stdout!r}"
    test("paste_serial_delimiter", test_paste_serial_delimiter)

    def test_paste_three_files():
        with TempFiles({"a.txt": "1\n2\n", "b.txt": "a\nb\n", "c.txt": "x\ny\n"}) as paths:
            r = run(["paste", paths["a.txt"], paths["b.txt"], paths["c.txt"]])
            assert r.stdout == "1\ta\tx\n2\tb\ty\n", f"got {r.stdout!r}"
    test("paste_three_files", test_paste_three_files)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("Codepod Coreutils Test Suite")
    print("=" * 50)

    register_echo_tests()
    register_basename_tests()
    register_seq_tests()
    register_wc_tests()
    register_cut_tests()
    register_head_tests()
    register_tail_tests()
    register_sort_tests()
    register_uniq_tests()
    register_base64_tests()
    register_fold_tests()
    register_paste_tests()
    register_tr_tests()
    register_dirname_tests()
    register_basename_edge_tests()

    # Extra tests
    register_seq_extra_tests()
    register_sort_extra_tests()
    register_head_tail_extra_tests()
    register_wc_extra_tests()
    register_cut_extra_tests()
    register_tr_extra_tests()
    register_base64_extra_tests()
    register_uniq_extra_tests()
    register_fold_extra_tests()
    register_paste_extra_tests()

    print("\n" + "=" * 50)
    print(f"Results: {passed} passed, {failed} failed, {skipped} skipped")
    print(f"Total:   {passed + failed + skipped} tests")

    if errors:
        print(f"\nFailures ({len(errors)}):")
        for name, msg in errors:
            print(f"  - {name}: {msg}")

    sys.exit(0 if failed == 0 else 1)
