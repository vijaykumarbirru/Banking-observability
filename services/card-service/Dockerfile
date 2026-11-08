FROM gradle:8.10.2-jdk21 AS build
WORKDIR /src
COPY settings.gradle.kts build.gradle.kts ./
RUN gradle dependencies --no-daemon -q > /dev/null
COPY src ./src
RUN gradle buildFatJar --no-daemon -q

FROM eclipse-temurin:21-jre-alpine
RUN adduser -D -u 10001 app
WORKDIR /app
# OpenTelemetry Java agent: traces, metrics and logs without code changes.
# Loaded only when JAVA_TOOL_OPTIONS sets -javaagent (see docker-compose.observability.yml).
ADD --chmod=755 https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v2.10.0/opentelemetry-javaagent.jar /otel/opentelemetry-javaagent.jar
COPY --from=build /src/build/libs/card-service-all.jar app.jar
USER app
EXPOSE 8091
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "app.jar"]
