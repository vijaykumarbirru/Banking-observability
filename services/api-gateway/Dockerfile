FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api-gateway .

FROM alpine:3.20
RUN adduser -D -u 10001 app
COPY --from=build /out/api-gateway /usr/local/bin/api-gateway
USER app
EXPOSE 8000
ENTRYPOINT ["api-gateway"]
