#include "sqlite3.h"

struct sqlite3 {
  int placeholder;
};

struct sqlite3_stmt {
  int placeholder;
};

static const char *CODEPOD_SQLITE_ERRMSG = "sqlite stub";
static const char *CODEPOD_SQLITE_VERSION = "3.0.0-codepod-stub";
static sqlite3 CODEPOD_SQLITE_DB = {0};
static sqlite3_stmt CODEPOD_SQLITE_STMT = {0};

int sqlite3_open(const char *filename, sqlite3 **ppDb) {
  (void)filename;
  if (ppDb) {
    *ppDb = &CODEPOD_SQLITE_DB;
  }
  return 0;
}

int sqlite3_close(sqlite3 *db) {
  (void)db;
  return 0;
}

const char *sqlite3_errmsg(sqlite3 *db) {
  (void)db;
  return CODEPOD_SQLITE_ERRMSG;
}

int sqlite3_changes(sqlite3 *db) {
  (void)db;
  return 0;
}

long long sqlite3_last_insert_rowid(sqlite3 *db) {
  (void)db;
  return 0;
}

const char *sqlite3_libversion(void) {
  return CODEPOD_SQLITE_VERSION;
}

int sqlite3_prepare_v2(
    sqlite3 *db,
    const char *zSql,
    int nByte,
    sqlite3_stmt **ppStmt,
    const char **pzTail
) {
  (void)db;
  (void)zSql;
  (void)nByte;
  if (ppStmt) {
    *ppStmt = &CODEPOD_SQLITE_STMT;
  }
  if (pzTail) {
    *pzTail = 0;
  }
  return 0;
}

int sqlite3_step(sqlite3_stmt *stmt) {
  (void)stmt;
  return 101;
}

int sqlite3_finalize(sqlite3_stmt *stmt) {
  (void)stmt;
  return 0;
}

int sqlite3_column_count(sqlite3_stmt *stmt) {
  (void)stmt;
  return 0;
}

int sqlite3_column_type(sqlite3_stmt *stmt, int iCol) {
  (void)stmt;
  (void)iCol;
  return 5;
}

const char *sqlite3_column_name(sqlite3_stmt *stmt, int n) {
  (void)stmt;
  (void)n;
  return "";
}

long long sqlite3_column_int64(sqlite3_stmt *stmt, int iCol) {
  (void)stmt;
  (void)iCol;
  return 0;
}

double sqlite3_column_double(sqlite3_stmt *stmt, int iCol) {
  (void)stmt;
  (void)iCol;
  return 0.0;
}

const char *sqlite3_column_text(sqlite3_stmt *stmt, int iCol) {
  (void)stmt;
  (void)iCol;
  return "";
}

const unsigned char *sqlite3_column_blob(sqlite3_stmt *stmt, int iCol) {
  (void)stmt;
  (void)iCol;
  return 0;
}

int sqlite3_column_bytes(sqlite3_stmt *stmt, int iCol) {
  (void)stmt;
  (void)iCol;
  return 0;
}

int sqlite3_bind_int64(sqlite3_stmt *stmt, int idx, long long val) {
  (void)stmt;
  (void)idx;
  (void)val;
  return 0;
}

int sqlite3_bind_double(sqlite3_stmt *stmt, int idx, double val) {
  (void)stmt;
  (void)idx;
  (void)val;
  return 0;
}

int sqlite3_bind_text(sqlite3_stmt *stmt, int idx, const char *val, int n, long destructor) {
  (void)stmt;
  (void)idx;
  (void)val;
  (void)n;
  (void)destructor;
  return 0;
}

int sqlite3_bind_blob(
    sqlite3_stmt *stmt,
    int idx,
    const unsigned char *val,
    int n,
    long destructor
) {
  (void)stmt;
  (void)idx;
  (void)val;
  (void)n;
  (void)destructor;
  return 0;
}

int sqlite3_bind_null(sqlite3_stmt *stmt, int idx) {
  (void)stmt;
  (void)idx;
  return 0;
}
