FROM node:22-alpine AS build

WORKDIR /app

COPY package.json ./
COPY package-lock.json* yarn.lock* pnpm-lock.yaml* ./

RUN set -eux; \
    corepack enable; \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
    elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; \
    fi

COPY . .

RUN set -eux; \
    if [ -f pnpm-lock.yaml ]; then pnpm run build; \
    elif [ -f yarn.lock ]; then yarn build; \
    else npm run build; \
    fi

RUN set -eux; \
    mkdir -p /app/_site; \
    copied=0; \
    for dir in dist build out; do \
      if [ -d "$dir" ]; then \
        cp -R "$dir"/. /app/_site/; \
        copied=1; \
        break; \
      fi; \
    done; \
    if [ "$copied" -ne 1 ]; then \
      echo "No static build output found. Expected one of: dist, build, out." >&2; \
      exit 1; \
    fi

FROM nginx:1.27-alpine AS runtime

COPY docker/landing-page/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/_site/ /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
