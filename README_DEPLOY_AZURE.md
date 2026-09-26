# Deploying the HCA Label Tool to Azure App Service (Container)

This document shows a simple Docker-based deployment flow to Azure App Service and an Azure Database for MySQL (managed). It assumes you have the Azure CLI installed and are logged in (`az login`).

1) Prepare image and repo

- Build and test locally (requires Docker):

```bash
docker build -t hca:latest .
docker run -p 5000:5000 --env MYSQL_HOST=mysql --env MYSQL_USER=root --env MYSQL_PASSWORD=example hca:latest
```

- Or run with docker-compose (local MySQL):

```bash
docker-compose up --build
```

2) Create Azure resources (example names, change as needed)

```bash
az login
az group create --name hca-rg --location eastus
az acr create --resource-group hca-rg --name hcaregistry --sku Basic
az acr login --name hcaregistry
```

3) Tag & push image to ACR

```bash
ACR_NAME=hcaregistry
IMAGE_NAME=hca
FULL_IMAGE=${ACR_NAME}.azurecr.io/${IMAGE_NAME}:v1
docker tag hca:latest ${FULL_IMAGE}
docker push ${FULL_IMAGE}
```

4) Provision Azure Database for MySQL (Flexible Server)

```bash
az mysql flexible-server create --resource-group hca-rg --name hca-mysql --location eastus \
  --admin-user azureuser --admin-password 'ChangeMe123!' --sku-name Standard_B1ms
az mysql flexible-server firewall-rule create --resource-group hca-rg --name hca-mysql --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
```

Note: For production lock down firewall rules and use a secure password. Also enable SSL enforcement as required by your DB client.

5) Create an App Service plan and Web App for Containers

```bash
az appservice plan create --name hca-plan --resource-group hca-rg --is-linux --sku P1v2
az webapp create --resource-group hca-rg --plan hca-plan --name hca-webapp --deployment-container-image-name ${FULL_IMAGE}
```

6) Configure the Web App to pull from ACR (if private)

```bash
az webapp config container set --name hca-webapp --resource-group hca-rg \
  --docker-custom-image-name ${FULL_IMAGE} --docker-registry-server-url https://${ACR_NAME}.azurecr.io
# If ACR requires credentials, set them or grant the Web App managed identity pull permissions.
```

7) Set environment variables (DB connection etc.)

```bash
az webapp config appsettings set --resource-group hca-rg --name hca-webapp --settings \
  MYSQL_HOST=hca-mysql.mysql.database.azure.com MYSQL_USER=azureuser MYSQL_PASSWORD='ChangeMe123!' MYSQL_DATABASE=hca
```

8) Model file and large assets

- The repository contains `yolov8n.pt`. You can either bake this into the image (we COPY it in the `Dockerfile`) or store it in Azure Blob Storage and download at startup. If the model is large, prefer Blob Storage to avoid large image pushes.

9) Notes & troubleshooting

- TensorFlow and some packages can increase image size and may require extra OS deps. If builds fail, try using an official TensorFlow wheel-compatible base image or use a multi-stage build.
- Use the App Service logs and `az webapp log tail --name hca-webapp --resource-group hca-rg` to debug container start issues.

10) Alternatives

- Use Azure App Service for code (no container) by deploying source, but then ensure the runtime on App Service supports your TF binary. Container gives more control and is recommended here.
