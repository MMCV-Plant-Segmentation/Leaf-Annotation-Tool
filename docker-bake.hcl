variable "UV_VERSION" {
  default = "0.11.15"
}

variable "PORT" {
  default = "5000"
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
