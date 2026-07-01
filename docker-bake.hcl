variable "UV_VERSION" {
  default = "0.11.15"
}

variable "PORT" {
  default = "5000"
}

# Build-time version identity (docs/plans/Plan — Version everything (stack-wide).md).
# Overridable via matching-named env vars, e.g.:
#   GIT_SHA=$(git rev-parse --short HEAD) BUILD_TIME=$(date -u +%FT%TZ) docker buildx bake
# Left unset (default "") the image falls back to "unknown"/"dev" at runtime.
variable "GIT_SHA" {
  default = ""
}

variable "BUILD_TIME" {
  default = ""
}

group "default" {
  targets = ["app", "lsyncd"]
}

group "all" {
  targets = ["app", "lsyncd", "test"]
}

target "frontend" {
  context    = "."
  dockerfile = "Dockerfile.frontend"
}

target "app" {
  context    = "."
  dockerfile = "Dockerfile"
  contexts = {
    frontend-build = "target:frontend"
  }
  args = {
    UV_VERSION = UV_VERSION
    PORT       = PORT
    GIT_SHA    = GIT_SHA
    BUILD_TIME = BUILD_TIME
  }
  tags = ["leaf-annotation:latest"]
}

target "lsyncd" {
  context    = "."
  dockerfile = "Dockerfile.lsyncd"
  tags       = ["leaf-lsyncd:latest"]
}

target "test" {
  context    = "."
  dockerfile = "Dockerfile.test"
  contexts = {
    frontend-build = "target:frontend"
  }
  args = {
    UV_VERSION = UV_VERSION
  }
  tags = ["leaf-annotation-test:latest"]
}
