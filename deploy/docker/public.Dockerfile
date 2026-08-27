FROM nginx:1.29.1-alpine@sha256:42a516af16b852e33b7682d5ef8acbd5d13fe08fecadc7ed98605ba5e3b26ab8

COPY deploy/docker/public-nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/snippets/public-security-headers.conf /etc/nginx/snippets/oknotika-public-security-headers.conf

COPY index.html style.css script.js /srv/oknotika/public/
COPY aluminum /srv/oknotika/public/aluminum
COPY articles /srv/oknotika/public/articles
COPY carbon-glass /srv/oknotika/public/carbon-glass
COPY glass /srv/oknotika/public/glass
COPY img /srv/oknotika/public/img
COPY js /srv/oknotika/public/js
COPY oknotika-smart-window /srv/oknotika/public/oknotika-smart-window
COPY protectapeel /srv/oknotika/public/protectapeel
COPY pvc /srv/oknotika/public/pvc
COPY wood-stoller /srv/oknotika/public/wood-stoller

RUN install -d -o 1000 -g 1000 -m 0750 /srv/oknotika/article-releases

USER 101:1000
EXPOSE 8001
ENTRYPOINT ["nginx", "-g", "daemon off;"]
