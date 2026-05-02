#include <curl/curl.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct buffer {
  char *ptr;
  size_t len;
};

static size_t write_cb(char *data, size_t size, size_t nmemb, void *userdata) {
  struct buffer *buf = (struct buffer *)userdata;
  size_t n = size * nmemb;
  char *next = realloc(buf->ptr, buf->len + n + 1);
  if (!next) return 0;
  buf->ptr = next;
  memcpy(buf->ptr + buf->len, data, n);
  buf->len += n;
  buf->ptr[buf->len] = '\0';
  return n;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: libcurl-socket-canary [--insecure] URL\n");
    return 2;
  }

  int insecure = 0;
  const char *url = argv[1];
  if (strcmp(argv[1], "--insecure") == 0) {
    if (argc < 3) {
      fprintf(stderr, "usage: libcurl-socket-canary [--insecure] URL\n");
      return 2;
    }
    insecure = 1;
    url = argv[2];
  }

  CURL *curl = curl_easy_init();
  if (!curl) return 1;

  struct buffer body = {0};
  curl_easy_setopt(curl, CURLOPT_URL, url);
  curl_easy_setopt(curl, CURLOPT_CODEPOD_NETWORK, CURLCODEPOD_NETWORK_SOCKET);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
  if (insecure) {
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
  }

  CURLcode rc = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_cleanup(curl);

  if (rc != CURLE_OK) {
    fprintf(stderr, "curl error: %s\n", curl_easy_strerror(rc));
    free(body.ptr);
    return 1;
  }

  printf("status=%ld body=%s\n", status, body.ptr ? body.ptr : "");
  free(body.ptr);
  return 0;
}
