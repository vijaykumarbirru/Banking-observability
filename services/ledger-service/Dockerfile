FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ledger-service .

FROM alpine:3.20
RUN adduser -D -u 10001 app
COPY --from=build /out/ledger-service /usr/local/bin/ledger-service
USER app
EXPOSE 8084
ENTRYPOINT ["ledger-service"]
