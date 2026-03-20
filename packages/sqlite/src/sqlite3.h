#ifndef CODEPOD_SQLITE3_H
#define CODEPOD_SQLITE3_H

typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;

int sqlite3_open(const char *filename, sqlite3 **ppDb);
int sqlite3_close(sqlite3 *db);
const char *sqlite3_errmsg(sqlite3 *db);
int sqlite3_changes(sqlite3 *db);
long long sqlite3_last_insert_rowid(sqlite3 *db);
const char *sqlite3_libversion(void);

int sqlite3_prepare_v2(
    sqlite3 *db,
    const char *zSql,
    int nByte,
    sqlite3_stmt **ppStmt,
    const char **pzTail
);
int sqlite3_step(sqlite3_stmt *stmt);
int sqlite3_finalize(sqlite3_stmt *stmt);

int sqlite3_column_count(sqlite3_stmt *stmt);
int sqlite3_column_type(sqlite3_stmt *stmt, int iCol);
const char *sqlite3_column_name(sqlite3_stmt *stmt, int n);

long long sqlite3_column_int64(sqlite3_stmt *stmt, int iCol);
double sqlite3_column_double(sqlite3_stmt *stmt, int iCol);
const char *sqlite3_column_text(sqlite3_stmt *stmt, int iCol);
const unsigned char *sqlite3_column_blob(sqlite3_stmt *stmt, int iCol);
int sqlite3_column_bytes(sqlite3_stmt *stmt, int iCol);

int sqlite3_bind_int64(sqlite3_stmt *stmt, int idx, long long val);
int sqlite3_bind_double(sqlite3_stmt *stmt, int idx, double val);
int sqlite3_bind_text(sqlite3_stmt *stmt, int idx, const char *val, int n, long destructor);
int sqlite3_bind_blob(
    sqlite3_stmt *stmt,
    int idx,
    const unsigned char *val,
    int n,
    long destructor
);
int sqlite3_bind_null(sqlite3_stmt *stmt, int idx);

#endif
