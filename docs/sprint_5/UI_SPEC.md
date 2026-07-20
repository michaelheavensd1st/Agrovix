# UI Specification

## Navigation Philosophy

Agrovix follows a hybrid Farm Operating System (FarmOS) navigation model.

The goal is to organize the application around how farms operate daily while maintaining the familiarity of modern ERP systems.

## Main Navigation

- 🏠 Command Center
- 🌱 Production
- 📦 Inventory
- 📋 Operations
- 👥 Workforce
- 💰 Finance
- 📊 Analytics
- ⚙️ Administration

## Production

- Crops
- Livestock
- Poultry
- Aquaculture
- Production Batches

## Inventory

- Stock
- Warehouses
- Transfers
- Purchases
- Suppliers
- Assets

## Operations

- Tasks
- Work Orders
- Maintenance
- Incidents
- Calendar

## Workforce

- Employees
- Attendance
- Teams
- Roles

## Finance

- Sales
- Expenses
- Budgets
- Profit & Loss

## Analytics

- KPIs
- Reports
- Forecasts
- AI Insights

## Administration

- Farms
- Users
- Permissions
- Integrations
- Settings

## Inventory Module Screen Hierarchy

The Inventory module is organized around the daily movement, storage, monitoring, and control of farm resources.

### Inventory Dashboard

The Inventory Dashboard provides an immediate operational overview of stock conditions across the selected farm.

It should display:

- Total active inventory items
- Total estimated stock value
- Low-stock items
- Out-of-stock items
- Items approaching expiry
- Recent inventory movements
- Pending stock transfers
- Warehouse utilization
- Quick actions

### Stock Items

The Stock Items screen provides a searchable and filterable list of all inventory items.

Primary item categories include:

- Feed
- Medicine
- Vaccines
- Chemicals
- Seeds
- Fertilizer
- Consumables
- Packaging materials
- Equipment
- Spare parts
- Harvest products
- Custom categories

Users should be able to:

- View stock quantities
- Search by item name or SKU
- Filter by category
- Filter by warehouse
- Filter by stock status
- Open an item record
- Create a new inventory item
- Record stock received
- Record stock issued

### Inventory Item Details

Each inventory item should have a dedicated details screen.

The screen should show:

- Item name
- SKU
- Category
- Unit of measurement
- Current quantity
- Available quantity
- Reserved quantity
- Reorder level
- Preferred supplier
- Average unit cost
- Estimated stock value
- Storage locations
- Expiry information
- Recent transactions
- Audit history

### Warehouses

The Warehouses screen displays all storage locations belonging to the selected farm.

A warehouse may represent:

- Main store
- Feed store
- Medicine store
- Cold room
- Equipment store
- Farm section store
- Virtual storage location

Users should be able to:

- View warehouse stock
- View warehouse capacity
- Create a warehouse
- Edit warehouse details
- Transfer stock between warehouses
- Review warehouse activity

### Inventory Transactions

The Transactions screen provides a complete record of inventory movements.

Transaction types include:

- Stock receipt
- Stock issue
- Stock transfer
- Stock adjustment
- Stock reservation
- Reservation release
- Return
- Waste
- Expired stock
- Damaged stock

Users should be able to filter transactions by:

- Date range
- Item
- Category
- Warehouse
- Transaction type
- User
- Production batch

### Transfers

The Transfers screen manages stock movement between warehouses or farm locations.

Transfers are executed immediately using the existing Inventory API.

Approval workflows, draft transfers, and in-transit states are reserved for a future sprint.

Each transfer should contain:

- Source warehouse
- Destination warehouse
- Items
- Quantities
- Requested by
- Timestamp
- Notes
- Audit history

### Adjustments

The Adjustments screen allows authorized users to correct inventory discrepancies.

Adjustment reasons include:

- Physical count correction
- Damage
- Expiry
- Theft
- Loss
- Data-entry correction
- Waste
- Other authorized reason

Every adjustment must require:

- A reason
- A quantity
- A warehouse
- A responsible user
- A timestamp
- An audit record

### Inventory Audit History

The Audit History screen provides a tamper-resistant record of inventory activity.

It should record:

- Who performed the action
- What action was performed
- Which inventory record was affected
- Previous value
- New value
- Date and time
- Farm
- Warehouse
- Related production batch
