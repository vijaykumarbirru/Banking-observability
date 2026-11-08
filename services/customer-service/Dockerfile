FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# OpenTelemetry: install instrumentation for every library found above (FastAPI, psycopg, pika, pymongo...).
RUN opentelemetry-bootstrap -a install
COPY app ./app
RUN useradd -u 10001 app
USER app
EXPOSE 8082
# opentelemetry-instrument switches the instrumentation on before the app starts.
CMD ["opentelemetry-instrument", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8082", "--no-access-log"]
