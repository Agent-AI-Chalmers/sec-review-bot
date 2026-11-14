# This image exists only to exercise the Docker backend contract in tests.
# Keep it small: production-image compatibility is outside this test suite's scope.
FROM python:3.14-alpine

# Git supports bind-mounted repositories.
RUN apk add --no-cache git
