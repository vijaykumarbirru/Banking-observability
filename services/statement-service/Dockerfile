FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/statement-service .

FROM alpine:3.20
RUN adduser -D -u 10001 app
COPY --from=build /out/statement-service /usr/local/bin/statement-service
USER app
EXPOSE 8089
ENTRYPOINT ["statement-service"]
