FROM nginx:1.29.1-alpine@sha256:42a516af16b852e33b7682d5ef8acbd5d13fe08fecadc7ed98605ba5e3b26ab8

COPY deploy/docker/public-nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/snippets/public-security-headers.conf /etc/nginx/snippets/oknotika-public-security-headers.conf

COPY public-app/index.html public-app/style.css public-app/script.js /var/home/oknotika/public-app/
COPY public-app/aluminum /var/home/oknotika/public-app/aluminum
COPY public-app/articles /var/home/oknotika/public-app/articles
COPY public-app/carbon-glass /var/home/oknotika/public-app/carbon-glass
COPY public-app/glass /var/home/oknotika/public-app/glass
COPY public-app/img /var/home/oknotika/public-app/img
COPY public-app/js /var/home/oknotika/public-app/js
COPY public-app/oknotika-smart-window /var/home/oknotika/public-app/oknotika-smart-window
COPY public-app/protectapeel /var/home/oknotika/public-app/protectapeel
COPY public-app/pvc /var/home/oknotika/public-app/pvc
COPY public-app/wood-stoller /var/home/oknotika/public-app/wood-stoller

RUN install -d -o 1000 -g 1000 -m 0750 \
      /var/home/oknotika/admin-app/data/article-releases

USER 101:1000
EXPOSE 8001
ENTRYPOINT ["nginx", "-g", "daemon off;"]
